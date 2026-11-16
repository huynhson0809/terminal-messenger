export function parseCommand(line) {
  const trimmed = String(line ?? "").trim();
  if (trimmed === "") return { kind: "empty" };
  if (trimmed.startsWith("//")) return { kind: "send", text: trimmed.slice(1) };
  if (!trimmed.startsWith("/")) return { kind: "send", text: trimmed };

  const [cmd, ...args] = trimmed.split(/\s+/);
  switch (cmd) {
    case "/list":
      return { kind: "list" };
    case "/back":
      return { kind: "back" };
    case "/quit":
      return { kind: "quit" };
    case "/open": {
      if (args.length !== 1 || !/^\d+$/.test(args[0]) || Number(args[0]) < 1) {
        return { kind: "error", message: "usage: /open <number>" };
      }
      return { kind: "open", n: Number(args[0]) };
    }
    case "/react": {
      if (args.length !== 1 || !/^[1-6]$/.test(args[0])) {
        return { kind: "error", message: "usage: /react <1-6>  (1 like, 2 love, 3 haha, 4 wow, 5 sad, 6 angry)" };
      }
      return { kind: "react", n: Number(args[0]) };
    }
    default:
      return {
        kind: "error",
        message: `unknown command ${cmd} (try /list, /open <n>, /react <1-6>, /back, /quit; use // to start a message with a slash)`,
      };
  }
}
