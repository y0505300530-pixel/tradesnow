/** Layer scale — spec §3.1: header < dialog < order event < toast */
export const Z = {
  /** Fixed GlobalNav shell + desktop dropdowns (above page sticky subheaders at z-100) */
  navShell: 110,
  header: 40,
  dialogOverlay: 50,
  dialog: 50,
  orderEvent: 60,
  toast: 70,
  /** Deep Analysis full-screen panel sits at dialog layer */
  analysisPanel: 50,
  analysisBackdrop: 50,
} as const;
