# Starz Realty PWA

A modern, installable rebuild of the Starz Realty (NW Indiana) website. Plain HTML/CSS/JS with no build step, so it can be hosted anywhere static (Vercel, Netlify, GitHub Pages, cPanel).

## Editing content (no code)
1. Open `/admin.html` (there's an "Edit site" link in the footer).
2. Change text, prices, photo links, team, areas and contact info. Add, remove or reorder listings, services and agents.
3. **Save & preview** shows the changes on the site in your browser only.
4. **Download content.json** and replace `content.json` on the host to publish.

Every word and image on the site comes from `content.json`. Developers can also edit that file directly.

## Before launch
- Replace the placeholder agents ("Agent Name") and the sample testimonials with real ones.
- Confirm the phone numbers, email, address and hours.
- Swap the stock photos for real listing and office photos.
- Hook the contact form up to a form service (e.g. Formspree) if you'd rather not use the visitor's email app.
- Optional: put `/admin.html` behind a password on the host.

## Run locally
`python3 -m http.server` in this folder, then open http://localhost:8000.

## PWA
`manifest.webmanifest` and `sw.js` make the site installable and let it open offline. Requests go to the network first, so edits show up right away.
