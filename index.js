import { verify } from "./lib/verify.js";
import { ingest } from "./lib/ingest.js";
import { worker } from "./lib/worker.js";
import { clean } from "./lib/clean.js";
import * as echo from "./lib/echo.js";

(async () => {
  const [action, ...args] = process.argv.slice(2);

  try {
    switch (action) {
      case "verify":
        await verify(args);
        break;
      case "ingest":
        await ingest(args);
        break;
      case "worker":
        await worker(args);
        break;
      case "clean":
        await clean(args);
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
