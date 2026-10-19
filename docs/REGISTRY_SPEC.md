# Registry contracts: a spec toward WHITEPAPER_1

*2026-10-16, updated 2026-10-18. Recommends the next contracts. It closes the gaps that `ChainRegistry` (`src/registry.ts`) works around today. Section numbers refer to `tmp/WHITEPAPER_1.md`.*

## Where we are

*Updated 2026-10-18: phase 2a landed as an in-place UUPS upgrade of the deployed proxies (upgrade-safe against their builds).*

- **The engine** (`src/engine/`) commits $\gamma = (e, \mathit{parent}, \mathit{root})$ over an MST, one repo per commit.
- **`src/registry.ts`** defines `Registry` (Definition 3.1 / 3.7): `head`, `accepted`, `exclusionCount`, `update` (carrying acceptances), `accept`, `exclude`, `restore`, `log` (the update log, or with `app` that app's log), `watch`.
- **`ChainRegistry`** maps it onto the contracts; **`MemRegistry`** (`src/test/mem-registry.ts`) is the paper's `Apply` in memory, the reference and the test double. One suite (`src/test/sdk-suite.ts`) runs on both.

What the contracts now do:

- `DataRegistry.update(repo, parent, head, apps[])`: heads keyed $(P, s)$ with positions, any address for its own repos, `Updated` carries the name in clear. Carried acceptances run after, each in a `try` with a fixed gas budget, so a refusal never undoes the update.
- `AppRegistry.accept(app, P, repo)`: forward-only acceptance of the current head. $\alpha_A$ is fixed: a member (`canPublish`) accepts its own heads, the owner pulls anyone's. `Accepted` carries the previous head.
- `AppRegistry.exclude` / `restore`: counters $\mathcal{C}(A, X)$ for a publisher, a repo or a key, named by hash, odd while in force. $\chi_A$ is the owner's say.

What is still open:

| Paper | Deployed | Consequence |
| --- | --- | --- |
| $h' = N(e, \mathit{parent}, \mathit{root})$, computed by the registry | The caller passes `head`, and only `parent` is checked | The parent and epoch guards run client-side (`FangornEngine.pushCommit`). Another client can skip them |
| Epoch window $e(t) - W \le e \le e(t)$ | None | — |
| The update and app logs as MMRs | Events only | No history reads, and no completeness against a light reader (Theorem 4, Prop 3.8) |
| $\alpha_A$, $\chi_A$ as rules, with witnesses anyone may submit | Fixed: membership, or the owner | Validators can't approve heads; nobody but the owner pulls or excludes |
| Acceptance of a past position, by log opening | Current head only | An app can't accept a head the publisher has since moved past |
| No global powers | Global ban (read as an exclusion in every app), app takedown, UUPS upgrades | Trust the paper doesn't state. Kept on purpose while on testnet |
| Directory lists for storage proofs (§5) | None | — |

## Recommendation

Use **two contracts**, as §3.2 and §5 suggest. A third, for validation rules ($\mathcal{R}, \mathcal{V}$), comes later.

### 1. `RepoRegistry`: $\mathcal{H}$ and $\mathcal{U}$

```solidity
struct Head { uint64 pos; bytes32 head; }      // H(P, s); (0, 0) for a repo never written

mapping(address => mapping(bytes32 => Head)) public heads;   // P => keccak(s) => H
mapping(address => bytes32[]) public repos;                  // P's repo list, appended on first write (§5)
uint64 public logSize;                                       // M
mapping(uint8 => bytes32) public logPeaks;                   // MMR peak by height (§6)

event Updated(
    address indexed publisher, bytes32 indexed repoId, string repo,
    uint64 pos, bytes32 parent, bytes32 head, uint64 epoch, bytes hint
);

function update(
    string calldata repo, uint64 epoch, bytes32 parent, bytes32 root,
    bytes calldata hint, Acceptance[] calldata acc
) external;
```

`update` is Apply lines 2–3:

1. `P = msg.sender`, `sid = keccak256(bytes(repo))`. Require `parent == heads[P][sid].head`, and require `e(block.timestamp) - W <= epoch <= e(block.timestamp)`. A late update reverts with `EpochExpired`, so tooling can recommit and retry.
2. Compute `h' = sha256(enc(epoch, parent, root))` (see *Commit encoding* below). Every stored head is then the name of a commit, and the parent chain and the log are one history (Theorem 3).
3. Set `heads[P][sid] = (pos + 1, h')`. On first write, push `sid` to `repos[P]`.
4. Append the leaf `keccak256(abi.encode(TAG_UPDATE, P, sid, pos + 1, h', block.timestamp))` to the MMR. Use `abi.encode`, never `encodePacked` (§5).
5. Emit `Updated`. It carries `repo` **in clear**, which replaces today's `repoOf` lookup. It also carries `hint`, below.
6. For each carried acceptance, call `AppRegistry.accept(...)` in a `try`. A failed acceptance never undoes the update (§3.2).

There is no admin, no app check, and no fee. Any address may commit to its own repos, and an update alone changes what no app presents.

**`hint`** is an opaque storage locator: today's CAR URI. It is emitted and never stored or hashed, so a commit's name depends on content only (delta report, item 6). Readers take it from the log entry. Hosts are untrusted anyway, so a wrong hint makes a read `fail`, never wrong.

#### Commit encoding

$h'$ is the sha256 digest of the commit block's dag-cbor bytes, which is exactly what `rootHexFromCid` puts on chain today. The block becomes `{epoch, parent, root}` and nothing more. Canonical dag-cbor sorts map keys by length, then bytewise, so the template is:

```
a3                                  map(3)
  64 'root'   d8 2a 58 25 00 01 71 12 20 <root:32>
  65 'epoch'  <uint, minimal encoding>
  66 'parent' (d8 2a 58 25 00 01 71 12 20 <parent:32>  |  f6 for ⊥)
```

The only variable-width part is `epoch` (1, 2, 3, 5 or 9 bytes). That is a few branches and one `sha256` precompile call, a few hundred gas (§5 [estimate]). The engine's `CommitBlock` drops `repo`, `message` and `car` in the same release:

- the name comes from the event;
- the CAR comes from `hint`;
- `message` goes in the event, or is dropped.

### 2. `AppRegistry`: $\mathcal{A}, \mathcal{D}, \mathcal{X}, \mathcal{C}$ and the app logs

```solidity
interface IRule { function check(bytes32 statement, bytes calldata witness) external view returns (bool); }

struct App { address owner; IRule accept; IRule exclude; }        // (n_A, o_A, α_A, χ_A), fixed at creation
struct Accepted { uint64 n; uint64 pos; bytes32 head; }           // D(A, P, s)

mapping(bytes32 => App) public apps;
mapping(bytes32 => mapping(address => mapping(bytes32 => Accepted))) public accepted;
mapping(bytes32 => mapping(bytes32 => uint64)) public exclusionCount;  // C(A, X); odd ⇒ excluded
mapping(bytes32 => address[]) public publishers;                       // per app, on first acceptance (§5)
mapping(bytes32 => mapping(address => bytes32[])) public appRepos;     // per app and publisher (§5)
mapping(bytes32 => uint64) public logSize;
mapping(bytes32 => mapping(uint8 => bytes32)) public logPeaks;

function createApp(bytes32 app, IRule acceptRule, IRule excludeRule) external;
function accept(bytes32 app, address P, bytes32 sid, uint64 pos, bytes32 head, uint64 deadline,
                bytes calldata witness, bytes calldata logOpening) external;
function exclude(bytes32 app, address P, bytes32 sid, bytes32 kid, uint64 deadline, bytes calldata witness) external;
function restore(bytes32 app, address P, bytes32 sid, bytes32 kid, uint64 deadline, bytes calldata witness) external;
```

- **`accept`** is Apply lines 4–5:
  - require `accepted[app][P][sid].pos < pos`, and `block.timestamp <= deadline`;
  - require that `head` is the head of `(P, sid)` at `pos`. Check it against `RepoRegistry.heads` when `pos` is current, and otherwise with `logOpening` against the update log's peaks (§5). **Phase 2a may accept the current position only**, and leave openings to 2b;
  - require `acceptRule.check(hashTypedData(Accept{app, P, sid, fromPos, pos, head, deadline}), witness)`;
  - write `accepted`, the lists on first acceptance, and the app-log leaf. Emit `Accepted`.

  Anyone may submit an acceptance.
- **`exclude` / `restore`** are Apply lines 6–9:
  - `X` is `(P, sid, kid)`, with zeros for the levels it doesn't name, and `xid = keccak256(abi.encode(P, sid, kid))`. Names stay hashed (§5);
  - require the parity: even to exclude, odd to restore;
  - require `excludeRule.check(hashTypedData(Exclude{app, op, P, sid, kid, count, deadline}), witness)`;
  - increment the counter, append to the app log, and emit.
- **Statements are EIP-712**, with domain `{name: "Fangorn", version: "2", chainId, verifyingContract}`, which together are $\iota$. Every statement names its count or `fromPos`, so a witness authorizes one change, once (Prop 3.2, Theorem 2).
- **Rules are contracts.** Ship three:
  - `OwnerSig`: signed by $o_A$;
  - `ListedSigner`: signed by a key in a list that $o_A$ controls, read when the entry applies, so removing a key revokes everything it signed but nobody has submitted yet;
  - `Open`: always true.

  **Today's join flow (invite, terms, fee) becomes a `ListedSigner` whose list is the joined publishers.** The publisher signs the `Accept` statement and carries it in its own update, which is exactly today's behaviour, now as one instance of the general rule.

### What goes away

- **Global suspension (`suspendPublisher`, `setGlobalSuspension`) and admin app suspension.** An app excludes for itself. A protocol-wide takedown, if wanted, is an app whose exclusions other apps' rules consult. That is a stated choice of those apps, not a power in the registry.
- **`seedNamespaceHead`.**
- **UUPS upgrades**, or keep them and state them as trust until the admin renounces. For a light reader, an upgrade can change $\mathsf{Apply}$.
- **Fees and storage subscriptions** stay as they are, but they must not gate `update`. They can gate `accept` through a rule that reads `acceptedTerms`, and the upload worker keeps billing by app.

## SDK changes when it lands

All of them sit behind `Registry`. `fangorn.ts` should not change. Done in 2a: `log` entries carry `pos` and `repo`, `accept` exists, and exclusions are counters.

1. In `ChainRegistry`:
   - `head` returns `(pos, head)`;
   - `log` entries carry `hint`;
   - `accept` takes `(pos, head, deadline, witness)`, plus a `dir(app, publisherRange)` read over the §5 lists.
2. Engine:
   - drop `repo`, `message` and `car` from `CommitBlock`;
   - resolve a commit's CAR from its log entry's `hint`, instead of from the commit block;
   - `pushCommit` passes `(repo, epoch, parent, root, hint)`, and its client-side parent check becomes redundant.
3. Subscriptions check `parent == previous head` by position rather than by value, and catch a dropped entry exactly.

Light-client verification (storage proofs at a final header, MMR openings, Theorem 4) is a separate step. The contracts above make it possible, since every value a reader needs sits in a slot it can name, but nothing in the SDK verifies proofs yet.
