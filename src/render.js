const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// Unread chats get a ● and, when `bold` is on (a real terminal), bold text.
// Names and previews are cleaned of control characters before they get here,
// so the only escape codes in the output are the ones added below.
export function renderChats(chats, { bold = false } = {}) {
  return chats.map((c, i) => {
    const line = `${c.unread ? "\u25cf" : " "} ${i + 1}. ${c.name} - ${c.preview ?? ""}`;
    return c.unread && bold ? `${BOLD}${line}${RESET}` : line;
  });
}

export function renderMessage(m, name) {
  const who = name ?? m.from;
  const body = m.text ? m.text : "[attachment]";
  return `${who}: ${body}`;
}
