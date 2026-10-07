// Turns whatever a trainer produced (a bare .safetensors file, or a tar /
// tar.gz / zip archive containing one) into a single .safetensors file, and
// stamps it with metadata so other tools can show the trigger word.

function u32(b: Uint8Array, at: number) {
  return (
    (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
  );
}

function u16(b: Uint8Array, at: number) {
  return b[at] | (b[at + 1] << 8);
}

// safetensors = u64 header length, JSON header, raw tensor data
export function isSafetensors(b: Uint8Array) {
  if (b.length < 10) return false;
  const len = u32(b, 0) + u32(b, 4) * 2 ** 32;
  return len > 1 && 8 + len <= b.length && b[8] === 0x7b; // "{"
}

async function decompress(
  data: Uint8Array,
  format: "gzip" | "deflate-raw",
): Promise<Uint8Array> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type ArchiveFile = { name: string; read: () => Promise<Uint8Array> };

function tarFiles(b: Uint8Array): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  const decoder = new TextDecoder();
  const str = (at: number, len: number) =>
    decoder.decode(b.subarray(at, at + len)).replace(/\0.*$/s, "");
  let at = 0;
  let longName = "";
  while (at + 512 <= b.length) {
    if (b[at] === 0) break; // end-of-archive block
    const size = parseInt(str(at + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(b[at + 156] || 48);
    const prefix = str(at + 345, 155);
    let name = longName || (prefix ? `${prefix}/` : "") + str(at, 100);
    longName = "";
    const start = at + 512;
    if (type === "L") {
      longName = str(start, size); // GNU long file name for the next entry
    } else if (type === "0" || type === "\0") {
      const data = b.subarray(start, start + size);
      files.push({ name, read: async () => data });
    }
    at = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function zipFiles(b: Uint8Array): ArchiveFile[] {
  // find the end-of-central-directory record from the back
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Corrupt zip archive");
  const count = u16(b, eocd + 10);
  let at = u32(b, eocd + 16);
  const decoder = new TextDecoder();
  const files: ArchiveFile[] = [];
  for (let i = 0; i < count; i++) {
    const method = u16(b, at + 10);
    const compressed = u32(b, at + 20);
    const nameLen = u16(b, at + 28);
    const extraLen = u16(b, at + 30);
    const commentLen = u16(b, at + 32);
    const local = u32(b, at + 42);
    const name = decoder.decode(b.subarray(at + 46, at + 46 + nameLen));
    const dataStart = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const raw = b.subarray(dataStart, dataStart + compressed);
    if (!name.endsWith("/")) {
      files.push({
        name,
        read: async () => {
          if (method === 0) return raw;
          if (method === 8) return decompress(raw, "deflate-raw");
          throw new Error(`Unsupported zip compression (${method})`);
        },
      });
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Finds the LoRA weights in a trainer's output.
export async function extractSafetensors(
  input: Uint8Array,
): Promise<Uint8Array> {
  let b = input;
  if (b[0] === 0x1f && b[1] === 0x8b) b = await decompress(b, "gzip");
  if (isSafetensors(b)) return b;

  const isZip = u32(b, 0) === 0x04034b50;
  const isTar = new TextDecoder().decode(b.subarray(257, 262)) === "ustar";
  if (!isZip && !isTar) {
    throw new Error("Trainer output isn't a .safetensors file or archive");
  }

  const candidates = (isZip ? zipFiles(b) : tarFiles(b)).filter(
    (f) =>
      f.name.toLowerCase().endsWith(".safetensors") &&
      !f.name.split("/").pop()!.startsWith("._"),
  );
  if (candidates.length === 0) {
    throw new Error("No .safetensors file found in the trainer output");
  }

  // prefer something named like a LoRA, then the biggest file
  const loaded = await Promise.all(
    candidates.map(async (f) => ({ name: f.name, data: await f.read() })),
  );
  loaded.sort(
    (a, b) =>
      Number(/lora/i.test(b.name)) - Number(/lora/i.test(a.name)) ||
      b.data.length - a.data.length,
  );
  const best = loaded[0].data;
  if (!isSafetensors(best))
    throw new Error("Found file isn't valid safetensors");
  return best;
}

export function readSafetensorsMetadata(b: Uint8Array): Record<string, string> {
  const len = u32(b, 0);
  const header = JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + len)));
  return header.__metadata__ ?? {};
}

// Returns a copy with extra entries merged into the header's __metadata__.
// Tensor data offsets are relative to the end of the header, so the header
// can grow; it's padded with spaces to keep tensor data 8-byte aligned.
export function withSafetensorsMetadata(
  b: Uint8Array,
  metadata: Record<string, string>,
): Blob {
  const len = u32(b, 0) + u32(b, 4) * 2 ** 32;
  const header = JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + len)));
  header.__metadata__ = { ...(header.__metadata__ ?? {}), ...metadata };

  let json = JSON.stringify(header);
  const encoder = new TextEncoder();
  let bytes = encoder.encode(json);
  const pad = (8 - (bytes.length % 8)) % 8;
  if (pad) bytes = encoder.encode(json + " ".repeat(pad));

  const prefix = new DataView(new ArrayBuffer(8));
  prefix.setUint32(0, bytes.length, true);
  prefix.setUint32(4, 0, true);
  return new Blob([new Uint8Array(prefix.buffer), bytes, b.subarray(8 + len)], {
    type: "application/octet-stream",
  });
}
