import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
// Caddy connects locally, so the API is never exposed directly to the LAN or router.
const host = process.env.HOST ?? "127.0.0.1";
createApp().listen(port, host, () => console.log(`SJSU Parking API listening on http://${host}:${port}`));
