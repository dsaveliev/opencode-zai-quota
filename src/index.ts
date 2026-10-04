import { createTuiPlugin } from "./tui"

// OpenCode TUI plugin module contract: default export { id, tui }.
// The runtime entry detector reads mod.default only; named exports are not detected.
export default { id: "zai-quota", tui: createTuiPlugin }
