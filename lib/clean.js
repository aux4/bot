import { clean as cleanRepo } from "./repository.js";

/**
 * Sweep expired records (ttl in the past) out of EVERY repository table in
 * aux4/bot's database — the event dedupe + reply-once claims (`events`),
 * sliding-ttl conversation state (`conversations`), and the generic
 * per-channel installations table (`installations`) a channel plugin may
 * use for its own OAuth/install bookkeeping — in a single
 * `aux4 repository clean` call.
 *
 * args: db
 */
export async function clean(args) {
  const [db] = args;
  const out = await cleanRepo(db);
  if (out) process.stdout.write(out + "\n");
}
