/** Single source for overlay stacking, so hosts cannot fight each other.

 previously the palette, modals, dialogs and toasts each hardcoded a z-index
 (`z-40`/`z-50`/`z-[60]`), and modals landing on the same layer as the global
 dialog host made the winner depend on DOM order while the command palette
 became unreachable under any open modal. Consume via style={{ zIndex }}:

 - modal  — ModalOverlay shells (page-level modals/drawers)
 - palette — command palette (keyboard-first: stays reachable above modals)
 - dialog — global DialogHost confirm/alert (must top any modal/palette)
 - toast  — transient notifications (always on top)
*/
export const Z_LAYERS = {
  modal: 50,
  palette: 55,
  dialog: 60,
  toast: 70,
} as const
