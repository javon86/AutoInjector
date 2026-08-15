'use strict';
// Helper process for the SCS-002 concurrency test. Opens the SAME database file
// as its siblings and inserts `count` messages as `source`, relying entirely on
// the message log's own numbering (never choosing a seq). Prints how many it
// committed. Args: <dbFile> <projectId> <source> <count>
const { openDatabase } = require('../shared/db');
const { MessageLog } = require('../shared/message-log');

const [dbFile, projectId, source, countStr] = process.argv.slice(2);
const count = parseInt(countStr, 10);

const db = openDatabase(dbFile);
const log = new MessageLog(db);

let ok = 0;
for (let i = 0; i < count; i++) {
  try {
    log.append({ projectId, from: source, body: `${source} message ${i}` });
    ok++;
  } catch (e) {
    process.stderr.write(`worker ${source} failed at ${i}: ${e.message}\n`);
  }
}
db.close();
process.stdout.write(String(ok));
process.exit(ok === count ? 0 : 1);
