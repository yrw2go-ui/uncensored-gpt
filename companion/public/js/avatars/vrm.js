// 3D avatar: any VRM model (VRoid Studio / VRoid Hub) rendered with three.js + three-vrm.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

export const DEFAULT_VRM =
  "https://cdn.jsdelivr.net/gh/pixiv/three-vrm@dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm";

export class VrmAvatar {
  constructor({ url } = {}) {
    this.url = url || DEFAULT_VRM;
    this.clock = new THREE.Clock();
    this.nextBlink = 0;
    this.blink = 0;
    this.mouth = 0;
  }

  async mount(root) {
    this.root = root;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    root.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    this.camera.position.set(0, 1.4, 1.2);
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    key.position.set(1, 2, 2);
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.6));

    this.onResize = () => this.resize();
    addEventListener("resize", this.onResize);
    this.resize();
    await this.load(this.url);
  }

  async load(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error("That file is not a VRM model.");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons?.(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x models face the other way

    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = vrm;
    this.scene.add(vrm.scene);

    // Relax the T-pose.
    const bone = (n) => vrm.humanoid?.getNormalizedBoneNode(n);
    if (bone("leftUpperArm")) bone("leftUpperArm").rotation.z = -1.2;
    if (bone("rightUpperArm")) bone("rightUpperArm").rotation.z = 1.2;
    if (bone("leftLowerArm")) bone("leftLowerArm").rotation.z = -0.15;
    if (bone("rightLowerArm")) bone("rightLowerArm").rotation.z = 0.15;
    vrm.update(0);

    // Frame a head-and-shoulders shot around the head bone.
    const head = new THREE.Vector3();
    (vrm.humanoid?.getRawBoneNode("head") || vrm.scene).getWorldPosition(head);
    this.camera.position.set(head.x, head.y - 0.02, head.z + 0.95);
    this.camera.lookAt(head.x, head.y - 0.08, head.z);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.root;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(level, state) {
    if (!this.vrm) return;
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    const em = this.vrm.expressionManager;

    // Lip-sync: drive the "aa" viseme (plus a little "oh") from loudness.
    this.mouth += (level - this.mouth) * 0.5;
    em?.setValue("aa", Math.min(1, this.mouth * 1.2));
    em?.setValue("oh", this.mouth * 0.3);

    // Blink every few seconds.
    if (t > this.nextBlink) {
      this.blink = 1;
      this.nextBlink = t + 2 + Math.random() * 4;
    }
    this.blink = Math.max(0, this.blink - dt * 8);
    em?.setValue("blink", this.blink > 0.5 ? 1 - (this.blink - 0.5) * 2 : this.blink * 2);
    em?.setValue("happy", state === "speaking" ? 0.25 : 0.1);

    // Idle head / body motion.
    const neck = this.vrm.humanoid?.getNormalizedBoneNode("neck");
    const spine = this.vrm.humanoid?.getNormalizedBoneNode("spine");
    if (neck) {
      neck.rotation.x = (state === "thinking" ? -0.12 : 0) + Math.sin(t * 1.1) * 0.02 + this.mouth * 0.05;
      neck.rotation.y = Math.sin(t * 0.5) * 0.08 + (state === "thinking" ? 0.15 : 0);
      neck.rotation.z = state === "listening" ? 0.08 : Math.sin(t * 0.7) * 0.03;
    }
    if (spine) spine.rotation.x = Math.sin(t * 1.4) * 0.015; // breathing

    this.vrm.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    removeEventListener("resize", this.onResize);
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}
