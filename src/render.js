export function renderChats(chats) {
  return chats.map(
    (c, i) => `${c.unread ? "*" : " "} ${i + 1}. ${c.name} - ${c.preview ?? ""}`,
  );
}

export function renderMessage(m, name) {
  const who = name ?? m.from;
  const body = m.text ? m.text : "[attachment]";
  return `${who}: ${body}`;
}
