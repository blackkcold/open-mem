export function injectStyles(...sheets: string[]): void {
  const style = document.createElement("style");
  style.dataset.openmem = "extension";
  style.textContent = sheets.filter(Boolean).join("\n");
  document.head.append(style);
}
