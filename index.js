import { verify } from "./lib/verify.js";
import { ingestPrepare, ingestSend, ingestReply } from "./lib/ingest.js";
import { leaseNormalize, workPullProcess, workPush } from "./lib/worker.js";
import { clean } from "./lib/clean.js";
import { sendCommand } from "./lib/send.js";
import { conversationsAction, messagesAction } from "./lib/messagelog.js";
import * as echo from "./lib/echo.js";

(async () => {
  const [action, ...args] = process.argv.slice(2);

  try {
    switch (action) {
      case "verify":
        await verify(args);
        break;
      case "ingest-prepare":
        await ingestPrepare(args);
        break;
      case "ingest-send":
        await ingestSend(args);
        break;
      case "ingest-reply":
        await ingestReply(args);
        break;
      case "lease-normalize":
        await leaseNormalize(args);
        break;
      case "work-pull-process":
        await workPullProcess(args);
        break;
      case "work-push":
        await workPush(args);
        break;
      case "clean":
        await clean(args);
        break;
      case "send":
        await sendCommand(args);
        break;
      case "conversations":
        await conversationsAction(args);
        break;
      case "messages":
        await messagesAction(args);
        break;
      case "echo-verify":
        await echo.verify();
        break;
      case "echo-ingest-parse":
        await echo.ingestParse();
        break;
      case "echo-typing":
        await echo.typing();
        break;
      case "echo-download":
        await echo.download();
        break;
      case "echo-format":
        await echo.format();
        break;
      case "echo-send":
        await echo.send();
        break;
      default:
        process.stderr.write(`Unknown action: ${action}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  }
})();
