export function SavePanel() {
  return (
    <button type="button" data-guide-id="guide-scan-save">
      Save
    </button>
  );
}

export function onSaved(notifyStepCompleted: (id: string) => void) {
  notifyStepCompleted('create_list');
}
