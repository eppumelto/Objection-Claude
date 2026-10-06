import { bundleClient } from './bundle.ts';

await bundleClient({ watch: false });
console.log('Client bundle built.');
