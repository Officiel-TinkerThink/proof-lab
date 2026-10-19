export const firstLine = error => (error instanceof Error ? error.message : String(error)).split("\n")[0];

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Drops undefined values so optional spec fields are not passed to Playwright as explicit undefined.
export const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

export const pick = (object, keys) => defined(Object.fromEntries(keys.map(key => [key, object[key]])));

export const readPath = (value, path) => path.split(".").reduce((node, part) => node?.[part], value);
