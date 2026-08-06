// Empreinte de déduplication — miroir EXACT de src/lib/parsing.ts côté client,
// pour que Bridge dédoublonne contre les imports manuels (§5, §4.2).

export function normalizeLibelle(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprint(
  bankAccountId: string,
  dateOperation: string,
  montant: number,
  libelle: string
): string {
  return [
    bankAccountId,
    dateOperation,
    montant.toFixed(2),
    normalizeLibelle(libelle),
  ].join("|");
}
