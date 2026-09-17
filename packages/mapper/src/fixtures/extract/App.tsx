import { Route, Routes, createBrowserRouter } from 'react-router-dom';

export const router = createBrowserRouter([
  { path: '/', element: null },
  { path: '/lists', element: null },
  { path: '/lists/:id', element: null },
]);

export function App() {
  return (
    <Routes>
      <Route path="/settings" element={<SettingsForm />} />
      <Route path="/help" element={<div>Help</div>} />
    </Routes>
  );
}

function SettingsForm() {
  return (
    <form onSubmit={(e) => e.preventDefault()} data-guide-id="guide-form-settings">
      <input name="title" data-guide-id="guide-textbox-title" />
      <button type="submit" data-guide-id="guide-button-save-settings">
        Save
      </button>
      <button type="button">Cancel</button>
    </form>
  );
}

export function CreatePanel() {
  return (
    <button type="button" data-guide-id="guide-button-create-list">
      Create
    </button>
  );
}
