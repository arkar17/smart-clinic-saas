// The preinstalled Playwright lives outside the workspace; loose types avoid adding a duplicate package.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module 'playwright' {
  export const chromium: any;
  export const webkit: any;
  export type Page = any;
  export type Browser = any;
}
