// Profile data is optional and is never an authenticated principal.
export function senderProfile(sender) {
  if (typeof sender?.displayName !== "string") return {};
  const displayName = sender.displayName.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return displayName ? { displayName, ...(typeof sender.id === "string" && /^[a-f0-9]{64}$/.test(sender.id) ? { id: sender.id } : {}) } : {};
}
