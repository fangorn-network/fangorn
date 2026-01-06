# ESM/CommonJS Interop Issue in @lit-protocol/networks

## Error Summary

When using `@lit-protocol/networks@8.3.2` in an ESM project (with `"type": "module"` in `package.json`), tests fail with the following error:

```
Error: require() of ES Module /path/to/@wagmi/core/dist/esm/exports/index.js from /path/to/@lit-protocol/networks/src/chains/ChronicleYellowstone.js not supported.

Instead change the require of index.js in ChronicleYellowstone.js to a dynamic import() which is available in all CommonJS modules.
```

## Root Cause

The `ChronicleYellowstone.js` file in `@lit-protocol/networks` uses CommonJS `require()` to import `@wagmi/core`, which is an ES Module. Node.js does not allow `require()` to load ES modules - they must be imported using dynamic `import()`.

**Problematic Code** (line 7 in `src/chains/ChronicleYellowstone.js`):

```javascript
const core_1 = require("@wagmi/core");
```

This fails because:

- `@wagmi/core` is an ES Module (exports ESM-only)
- The file is using CommonJS `require()`
- Node.js throws an error when trying to `require()` an ES module

## Affected Files

- `@lit-protocol/networks/src/chains/ChronicleYellowstone.js`

## Solution

Replace the synchronous `require()` with a dynamic `import()` and implement lazy initialization for the `WagmiConfig` export.

### Fixed Code

```javascript
const viem_1 = require("viem");
// Use dynamic import for @wagmi/core to support ESM modules
let core_1 = null;
let wagmiConfigCache = null;

async function getWagmiCore() {
	if (!core_1) {
		core_1 = await import("@wagmi/core");
	}
	return core_1;
}

async function getWagmiConfig() {
	if (wagmiConfigCache) {
		return wagmiConfigCache;
	}
	const wagmiCore = await getWagmiCore();
	wagmiConfigCache = (0, wagmiCore.createConfig)({
		chains: [exports.viemChainConfig],
		transports: {
			[exports.viemChainConfig.id]: (0, viem_1.http)(),
		},
	});
	return wagmiConfigCache;
}

// ... rest of the code ...

// Export WagmiConfig as a getter that lazily loads using dynamic import
Object.defineProperty(exports, "WagmiConfig", {
	get: function () {
		return getWagmiConfig();
	},
	enumerable: true,
	configurable: true,
});
```

### Key Changes

1. **Removed synchronous `require("@wagmi/core")`** - This was causing the error
2. **Added lazy loading with dynamic `import()`** - Uses `await import("@wagmi/core")` which works for both CommonJS and ESM contexts
3. **Made `WagmiConfig` a getter** - Returns a Promise that resolves to the config, allowing lazy initialization
4. **Added caching** - Prevents multiple imports of the same module

## Impact

- **Breaking Change**: If `WagmiConfig` is accessed synchronously elsewhere, it will now return a Promise instead of a value
- **Compatibility**: This change maintains backward compatibility for ESM projects while still working in CommonJS contexts

## Testing

The fix was tested with:

- Node.js v20.11.1
- pnpm 10.4.0
- Vitest 4.0.15
- Project with `"type": "module"` in `package.json`

## Temporary Workaround

Until this is fixed upstream, users can apply a patch using pnpm:

```bash
pnpm patch @lit-protocol/networks@8.3.2
# Make the changes described above
pnpm patch-commit <patch-directory>
```

A patch file has been created at: `patches/@lit-protocol__networks@8.3.2.patch`

## Related Issues

This issue occurs because:

- `@wagmi/core@2.22.1` is ESM-only (no CommonJS build)
- `@lit-protocol/networks` is compiled to CommonJS
- The interop between CommonJS and ESM requires dynamic imports

## Recommendation

Consider one of the following approaches:

1. **Convert to ESM**: If possible, convert `@lit-protocol/networks` to ESM to match `@wagmi/core`
2. **Use dynamic imports**: Use `import()` for all ESM dependencies (as shown in the fix)
3. **Dual package**: Provide both ESM and CommonJS builds
4. **Dependency update**: Check if `@wagmi/core` provides a CommonJS build that can be used

## Environment

- Package: `@lit-protocol/networks@8.3.2`
- Dependency: `@wagmi/core@2.22.1`
- Node.js: v20.11.1+
- Package Manager: pnpm 10.4.0
