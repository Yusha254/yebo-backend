export function generateTransactionId(network: "Telkom" | "Mtn" | "Vodacom") {
  const baseYear = 2025;
  const now = new Date();
  const yearCode = (now.getFullYear() - baseYear).toString();
  const months = "ABCDEFGHIJKL";
  const monthCode = months[now.getMonth()];

  const networkMap = {
    Telkom: "1",
    Mtn: "2",
    Vodacom: "3",
  };

  const networkCode = networkMap[network];

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let random = "";

  for (let i = 0; i < 4; i++) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }

  return `${yearCode}${monthCode}${networkCode}${random}`;
}