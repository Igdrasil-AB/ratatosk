// These expected errors are the regression: core has Web APIs but no Node or
// page globals. If an ambient type leaks in, TypeScript reports that the
// expected-error directive is unused and the boundary typecheck fails.
// @ts-expect-error Node process is unavailable in portable core.
void process.env;
// @ts-expect-error Page document is unavailable in portable core.
void document.title;

export {};
