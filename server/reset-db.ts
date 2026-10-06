import { db, seed, wipe } from './db.ts';
import { config } from './config.ts';

wipe(db);
const n = seed(db);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log(`Database reset at ${config.dbPath}; seeded ${n} built-in case(s).`);
