/**
 * Type shim: the reactive solid build is imported by file path (the package
 * root "solid-js" resolves to the SSR build under Bun's node condition,
 * which the loaded @opentui/solid bundle pairs with). The public API is the
 * same, so the package types apply.
 */
declare module "solid-js/dist/solid.js" {
  export * from "solid-js"
}
