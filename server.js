import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { createApp } from './lib/app.js';

const port = process.env.PORT || 3000;
createApp().listen(port, () => console.log(`wayfinder listening on :${port}`));
