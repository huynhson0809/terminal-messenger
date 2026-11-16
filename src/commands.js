export function parseCommand(line) {
  const trimmed = String(line ?? "").trim();
  if (trimmed === "") return { kind: "empty" };
  if (trimmed.startsWith("//")) return { kind: "send", text: trimmed.slice(1) };
  if (!trimmed.startsWith("/")) return { kind: "send", text: trimmed };

  const [cmd, ...args] = trimmed.split(/\s+/);
  if (cmd === "/reply") {
    const m = /^\/reply\s+(\d+)\s+([\s\S]+)$/.exec(trimmed);
    if (!m || Number(m[1]) < 1) return { kind: "error", message: "usage: /reply <message number> <text>" };
    return { kind: "reply", msg: Number(m[1]), text: m[2].trim() };
  }
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
    case "/latest": {
      if (args.length > 1 || (args.length === 1 && (!/^\d+$/.test(args[0]) || Number(args[0]) < 1))) {
        return { kind: "error", message: "usage: /latest [how many messages]" };
      }
      return args.length === 1 ? { kind: "latest", count: Number(args[0]) } : { kind: "latest" };
    }
    case "/clear":
      return { kind: "clear" };
    case "/more":
      return { kind: "more" };
    case "/react": {
      const usage = "usage: /react <1-6> [message number]  (1 like, 2 love, 3 haha, 4 wow, 5 sad, 6 angry)";
      if (args.length < 1 || args.length > 2 || !/^[1-6]$/.test(args[0])) return { kind: "error", message: usage };
      if (args.length === 2 && (!/^\d+$/.test(args[1]) || Number(args[1]) < 1)) return { kind: "error", message: usage };
      return args.length === 2
        ? { kind: "react", n: Number(args[0]), msg: Number(args[1]) }
        : { kind: "react", n: Number(args[0]) };
    }
    default:
      return {
        kind: "error",
        message: `unknown command ${cmd} (try /list, /open <n>, /more, /latest, /react <1-6> [msg#], /reply <msg#> <text>, /clear, /back, /quit; use // to start a message with a slash)`,
      };
  }
}
