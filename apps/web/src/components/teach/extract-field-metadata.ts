export type FieldMetadata = {
  fieldType?: string;
  autocomplete?: string;
  fieldLabel?: string;
};

/**
 * Extracts metadata from a focused input element safely, without capturing the value.
 * Returns type, autocomplete, and a safe label (from label text, aria-label, name or placeholder).
 */
export function extractFieldMetadata(): FieldMetadata {
  const active = document.activeElement;
  if (!active || !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
    return {};
  }

  const fieldType = active instanceof HTMLInputElement ? active.type : "textarea";
  const autocomplete = active.getAttribute("autocomplete") || undefined;

  let fieldLabel: string | undefined;
  if (active.id) {
    const label = document.querySelector(`label[for="${CSS.escape(active.id)}"]`);
    if (label?.textContent) fieldLabel = label.textContent.trim().slice(0, 50);
  }
  if (!fieldLabel) {
    fieldLabel =
      active.getAttribute("aria-label") ||
      active.getAttribute("name") ||
      active.getAttribute("placeholder") ||
      undefined;
  }
  if (fieldLabel) fieldLabel = fieldLabel.slice(0, 50);

  return { fieldType, autocomplete, fieldLabel };
}
