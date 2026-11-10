// Read the full AWS-style event that aux4/api pipes to the route command on stdin.
export function readStdin() {
  return new Promise(resolve => {
    let data = "";
    if (process.stdin.isTTY) {
      return resolve("");
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export function reply(obj) {
  process.stdout.write(JSON.stringify(obj));
}
