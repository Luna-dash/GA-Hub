/** Single source for overlay stacking, so hosts cannot fight each other.

 previously the palette, modals, dialogs and toasts each hardcoded a z-index
 (`z-40`/`z-50`/`z-[60]`), and modals landing on the same layer as the global
 dialog host made the winner depend on DOM order while the command palette
 became unreachable under any open modal. Consume via style={{ zIndex }}:

 - tooltip     — transient hover tooltips (never stack-fight an open modal)
 - popover     — non-modal dropdowns/popovers/floating helpers (below modals)
 - modal       — ModalOverlay shells (page-level modals/drawers)
 - contextMenu — portal context/select menus (above modals so in-modal selects work, below palette/dialog)
 - palette     — command palette (keyboard-first: stays reachable above modals)
 - dialog      — global DialogHost confirm/alert (must top any modal/palette)
 - toast       — transient notifications (always on top)
 - gate        — desktop runtime failure fallback; full-screen and must cover
                 every other registry consumer (was a stray z-[10001])
*/
export const Z_LAYERS = {
  tooltip: 40,
  popover: 45,
  modal: 50,
  contextMenu: 52,
  palette: 55,
  dialog: 60,
  toast: 70,
  gate: 80,
  // Native controls remain available above the early boot loader (z-index 9999).
  chrome: 10000,
} as const
