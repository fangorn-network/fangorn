# Fangorn I: Verifiable Data without a Platform

**Author: Tony Riemer (driemworks@fangorn.network) | Fangorn**

## 0. Introduction

Most data on the web lives on platforms. A platform stores the data, declares which version is current, decides who may write it, and runs the search through which it is found. Readers must trust it for all of these: that what they read is what was written, that it is current and complete, and that search shows what is actually there.

We seek the same functions without the platform. The model has three layers, each a Merkle DAG:

1. **Repos are Merkle clocks.** Each publisher's repo is a chain of signed events. Each event is a **diff** to the repo's data, plaintext or sealed, together with the root of the state it produces.
2. **The global root combines the clocks.** An ordering service places every repo's head into one total order. At each clock value, one root, the **global root** $\Gamma_t$, commits to the head of every repo. Through those heads it reaches every event, diff, state and record ever published. Views, such as indexes and embeddings, are functions of $\Gamma_t$, so anyone can recompute them.
3. **Apps are stitched DAGs.** An app is a repo whose records are **stitches**: links by name to events of other repos. The app's head reaches exactly the events it presents. It is therefore a curated sub-DAG of the global DAG, and it can neither forge nor alter what it presents.

**Part I** gives the model. **Part II** instantiates it: the ordering service is a blockchain, repo states are Merkle Search Trees, the global root is a sparse Merkle tree, and the update log is a Merkle mountain range. **Appendix A** builds the global index: exact, refutable search over every record, by meaning, with no gatekeeper. **Appendix B** lets a repo change faster than the ordering. **Appendix C** makes indexers accountable with fraud proofs.

### 0.1 Contributions

1. **Repos as diff clocks.** A repo is a single-writer Merkle clock whose events carry diffs and state roots (§2). Following a repo means reading its events, with no tree walks. An event whose root does not match its diff has a fraud proof of three openings (Proposition 2.2).
2. **One global root.** A registry over the ordering keeps every repo's head (§3). Its fold, $\Gamma_t$, is one name for everything published up to $t$. Anyone holding the ordering computes the same $\Gamma_t$, and a past global root is as well defined as the present one.
3. **Reads proven current and complete.** A light reader holding a checkpoint reads any slice of $\Gamma_t$ and obtains exactly that slice, or $\mathsf{fail}$, even if every host is adversarial (Theorem 4).
4. **Curation as stitches.** An app stitches events of other repos (§4). A stitch is checked with one log opening, and the stitching event provably happened after the event it stitches. No app admits a publisher, and no publisher needs an app.
5. **Views without authority.** A view is a deterministic function of $\Gamma_t$ (§5), so every honest party computes the same root. For pointwise views, a wrong root has a fraud proof of one opening and one point read (Appendix C).

Fangorn does not keep data available; that is left to hosts. Nor does it decide who may read data; that is [WP2]. Results are tagged **[proof]**, **[proof sketch]**, **[no proof]**, **[assumption]** or **[estimate]**, and §9 lists every claim without a full proof.

### 0.2 Related work

**AT Protocol** [KFH+24]. Each account's data is a signed Merkle Search Tree repository [AT19], merged by relays and indexed by AppViews. A signed commit proves what a repository holds, but not that it is the latest commit, so readers trust relays for completeness and AppViews for indexing. We replace both with the global root and recomputable views.

**Ceramic** [CER]. Each stream is a single-writer Merkle clock, anchored in batches on a chain. An anchor proves that an event existed, not that it is the latest, and forks are resolved by earliest anchor. Batching makes Ceramic's writes far cheaper than ours. We pay one transaction per head (§7), and that is the price of a head a reader can prove is current.

**Twine** [TW]. Chains of signed pulses, where each pulse hash-links its predecessor and pulses of other chains. The resulting Tapestry is a DAG whose paths give a verifiable partial order without consensus. Our stitches are the same kind of link (§4). Twine has no total order and no global root, so it cannot say that a pulse is the latest one or that a set of pulses is complete; the ordering service adds both.

**Farcaster** [FC] orders messages and data in one network, with per-account storage limits. **Nostr** [NIP01] has no order across relays, and no proof that a relay returned everything. **The Graph** [TG] indexes chain-ordered data, with disputes settled by an arbitrator. Our fraud proofs need no arbiter (Appendix C).

---

# Part I — The model

## 1. Preliminaries

### 1.1 Notation

$\lambda$ is the security parameter, and "efficient" means probabilistic polynomial-time. $\mathsf{enc}$ is a canonical injective encoding, and $F(x_1, \ldots, x_n)$ means $F(\mathsf{enc}(x_1, \ldots, x_n))$. $K \rightharpoonup V$ is a finite partial map. In algorithms, $\textbf{require } c$ returns $\mathsf{fail}$ if $c$ is false, and a failing call fails its caller. "From any source" means from an untrusted party, whose answer is checked before use. So $\mathsf{fail}$ only says that the sources asked did not supply what was needed.

### 1.2 Names and Merkle DAGs

A **naming function** $N : \{0,1\}^* \to \{0,1\}^{2\lambda}$ is **binding** if no efficient adversary finds $x \neq x'$ with $N(x) = N(x')$, except with negligible probability $\mathbf{Adv}^{\mathsf{bind}}_N$.

A **node** is $n = (v, C)$: a payload $v$ and an ordered sequence of links $C$, which are names of other nodes. Its name is $N(v, C)$. A **Merkle DAG** is a finite set of nodes, closed under links, with distinct names. $\mathcal{N}{\downarrow}\alpha$ is the sub-DAG reachable from the node named $\alpha$.

**Lemma 1.1 (A name fixes its DAG) [proof].** If two Merkle DAGs both contain a node named $\alpha$ but $\mathcal{N}{\downarrow}\alpha \neq \mathcal{N}'{\downarrow}\alpha$, their union contains a collision of $N$. With $N$ modelled as a random oracle, a Merkle DAG has a cycle with probability at most $q^2 / 2^{2\lambda}$ after $q$ queries.

_Proof._ Walk a path to a node in one DAG but not the other. The first point where the two walks differ gives two different nodes with the same name. For cycles: on any cycle, the node whose name was queried first contains a link to a name that was only computed later. $\square$

**Content addressing.** $\mathsf{Get}(\alpha)$ fetches a value from any source and returns it only if its name is $\alpha$. By Lemma 1.1, following links from a trusted name yields exactly the DAG below it. Every structure in this paper is a Merkle DAG named by its root. A name can only link to what already exists, so **a node happened after every node it reaches.** This one fact gives every order in §2–§4.

### 1.3 Commitments

**Definition 1.2 (Map commitment).** $\mathsf{Com}$ maps a finite map $D$ to a root, and is:

1. **binding:** $D \neq D'$ with $\mathsf{Com}(D) = \mathsf{Com}(D')$ is infeasible;
2. **uniquely represented:** $\mathsf{Com}(D)$ depends only on $D$;
3. **openable:** for a set $Q$ of keys, $\mathsf{Open}(D, Q) \to \pi$ and $\mathsf{Check}(\mathit{root}, Q, D', \pi) \in \{0,1\}$ accept $D|_Q$. Two accepted openings of one root on one $Q$ are equal, except with $\mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$. An opening therefore also proves absence.

Part II uses two map commitments. One has keys chosen by a single party and supports intervals (a Merkle Search Tree). The other has keys chosen by everyone and has a fixed shape (a sparse Merkle tree).

**Definition 1.3 (Log commitment).** $\mathsf{LCom}$ maps a sequence $L = (l_1, \ldots, l_M)$ to a root that fixes $M$. It has positional openings $\mathsf{Prove}(L, j)$ and $\mathsf{Verify}(\mathit{root}, j, l, \pi)$, binding except with $\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$. It has a small append state $\mathsf{st}(L)$ with $\mathsf{Append}(\mathsf{st}(L), l) = \mathsf{st}(L \Vert l)$ and $\mathsf{Root}(\mathsf{st}(L)) = \mathsf{LCom}(L)$.

### 1.4 Ordering service

A **Merkle clock** [MCRDT20] records events in a Merkle DAG. Each new event links to the current roots, so the DAG shows happened-before [L78]. With one writer it is a chain. With many writers it is a partial order, which systems usually resolve with CRDTs. We instead give each repo one writer, and use an ordering service to place all writers' heads in one total order.

**Definition 1.4 (Ordering service).** A sequence of entries $\mathcal{O} = (o_1, o_2, \ldots)$, each $o = (t, a, d, \mathit{op})$, where $t$ is a clock value, $a$ an author, $d$ a destination and $\mathit{op}$ an operation. $\mathsf{Read}(t)$ returns the prefix up to $t$, and $\mathsf{Verify}(d, \mathcal{O}')$ checks an extension of a checkpoint. An epoch is $e(t) = \lfloor t / \eta \rfloor$.

**Assumption O.** (1) **Agreement:** honest parties see the same sequence, except for entries less than $\delta$ old. (2) **Authorship:** an accepted entry by $a$ on $(d, \mathit{op})$ that $a$ never signed occurs with negligible probability. (3) **Clock:** clock values never decrease.

$t$ is **final** once it is more than $\delta$ old.

## 2. Repos

A **record** is $r = (\theta, v)$: a type and a payload. Payload values may be scalars, names of nodes, or ciphertexts. A **state** is a map $M : K \rightharpoonup \mathit{Rec}$, with root

$$
\mathsf{root}(M) = \mathsf{Com}\big(\{k \mapsto N(\texttt{rec}, M(k))\}\big).
$$

A **diff** is a map $\Delta : K \rightharpoonup \mathit{Rec} \cup \{\bot\}$, where $\bot$ deletes. $\mathsf{apply}(M, \Delta)$ overwrites $M$ with $\Delta$, removing every key mapped to $\bot$.

**Definition 2.1 (Event, repo).** A repo is $\rho = (P, s)$: a publisher $P$, who is an author of the ordering, and a name $s$. Only $P$ writes it. An **event** of $\rho$ is

$$
\varepsilon = (e,\ \mathit{parent},\ \mathit{diff},\ \mathit{root})
$$

- $e$ is the epoch in which it was made;
- $\mathit{parent}$ is the name of the previous event, or $\bot$;
- $\mathit{diff} = \mathsf{Com}(\Delta)$ commits the change;
- $\mathit{root}$ is the root of the resulting state.

The events form a single-writer Merkle clock, which is a chain. The **head** is $h = N(\varepsilon)$ of the latest event, $M_h$ is its state, and $M_\bot = \emptyset$. The event is **well-formed** if $\mathit{root} = \mathsf{root}(\mathsf{apply}(M_{\mathit{parent}}, \Delta))$.

So a head names the repo's whole history twice over: as a sequence of changes, by walking the diffs, and as the state at every step, by the roots. A reader who wants changes reads diffs. A reader who wants the state opens a root. Neither replays the other.

**Sealed data.** Nothing here reads a payload. A sealed record is a record whose fields are ciphertexts [WP2], and its diffs, roots and events are formed exactly as for plaintext. Every result in this paper holds for sealed data, about the ciphertexts.

**Proposition 2.2 (A malformed event is provable) [proof sketch].** If $\varepsilon$ is not well-formed, there is a key $k$ where $\mathsf{apply}(M_{\mathit{parent}}, \Delta)(k) \neq M_h(k)$. Openings of $\mathit{diff}$, of the parent's root, and of $\mathit{root}$, each on $[k, k]$, prove it to anyone. Walking the two state trees together finds such a $k$ in $O(h + 1)$ nodes per changed key (Lemma 8.1).

The registry never fetches an event (§3), so it never checks well-formedness. A malformed event harms only its own repo and whoever presents it, and every reader can see it.

**Hosts.** Every node is held by untrusted hosts and fetched by name, and each host keeps or drops data under its own policy. Data no host serves makes a read $\mathsf{fail}$, never return something else. Each publisher pins its own data.

## 3. The global root

### 3.1 The registry

The ordering service stores entries without interpreting them. A deterministic state machine run over it, the **registry**, gives them meaning. A registry has an identifier $\iota$, unique among registries, and a window of $W \ge 1$ epochs. It reads only the entries addressed to it, $\mathcal{O}_\iota$, written $o = (t, a, \mathit{op})$. By Assumption O.2, an entry signed for $\iota'$ is not an entry for $\iota$.

**Definition 3.1 (Registry).** The state is $R = (\mathcal{H}, \mathcal{U})$, where $\mathcal{H}(\rho) = (\mathit{pos}, h)$, starting at $(0, \bot)$, and $\mathcal{U}$ is the **update log**.

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{Apply}(R, o) \qquad (o = (t, a, \mathit{op});\ \text{a failed } \textbf{require} \text{ leaves } R \text{ unchanged}) \\
\hline
1: & \textbf{case } \mathit{op} = \mathsf{update}(s, e, \mathit{parent}, \mathit{diff}, \mathit{root})\textbf{: } (i, h) \gets \mathcal{H}(a, s);\ \textbf{require } \mathit{parent} = h \wedge e(t) - W \le e \le e(t) \\
2: & \quad h' \gets N(e, \mathit{parent}, \mathit{diff}, \mathit{root});\ \mathcal{H}(a, s) \gets (i + 1, h');\ \mathcal{U} \gets \mathcal{U} \Vert (a, s, i + 1, h', t) \\
\hline
\end{array}
$$

That is the whole registry. It computes each head from the event's fields, and never fetches an event or a state. An update applies only while its parent is the head. Heads never repeat (Theorem 3), so a signed update applies at most once. The epoch window lets an update survive $W$ epochs of inclusion delay. Whoever orders entries can delay an update, but cannot make a late one land.

$R_t$ is the registry after applying $\mathsf{Read}_\iota(t)$. $H_t(\rho)$ and $\mathit{pos}_t(\rho)$ are a repo's head and position at $t$. The history of $\rho$ is its heads $h_1, h_2, \ldots$ in order, which is also its chain of parents.

**Lemma 3.2 (The log locates every head) [proof].** For each $\rho$ and each $1 \le i \le \mathit{pos}_t(\rho)$, $\mathcal{U}_t$ holds exactly one entry for $(\rho, i)$, and these entries appear in order of $i$. Clock values do not decrease along the log. Two authenticated entries for $\rho$ at the same position are equal.

_Proof._ Each valid update sets the next position and appends once, in the order of $\mathcal{O}$. $\square$

### 3.2 Combining the clocks

**Definition 3.3 (Global root).** The **global root** at $t$ is

$$
\Gamma_t = \mathsf{GCom}\Big(\big\{\, P \mapsto \mathsf{GCom}\big(\{\, s \mapsto (\mathit{pos}_t(P, s),\ H_t(P, s)) \,\}\big) \,\big\}\Big)
$$

over every repo with a head. Here $\mathsf{GCom}$ is a map commitment with a fixed shape, keyed by $N(P)$ and $N(s)$ (§8). The inner root is $P$'s **publisher root**.

$\Gamma_t$ links to every head. Each head links to its event, the event to its diff and its state, and the state to its records. So $\Gamma_t$ is one Merkle DAG containing every repo's clock: one name for everything published up to $t$. It plays the role a merge node plays in a Merkle clock with many writers, a single root from which every writer's head descends. The difference is that the ordering decides which heads it holds, so no CRDT is needed.

The **global state** is $\mathcal{G}_t(\rho, k) = M_{H_t(\rho)}(k)$, the map that $\Gamma_t$ reaches. It records what was written, and nothing else.

**Proposition 3.4 (The global root is determined) [proof].** $\Gamma_t$ is a function of $\mathsf{Read}_\iota(t)$ alone: it is the fold of $\mathcal{U}_t$ that keeps, for each repo, its last entry. For a final $t$, every honest party computes the same $\Gamma_t$. A past global root is as well defined as the present one.

_Proof._ Assumption O.1, then determinism of $\mathsf{Apply}$ and unique representation of $\mathsf{GCom}$. $\square$

Keys are chosen by every publisher, which is why $\mathsf{GCom}$ must have a shape that no one chooses (§8). Within a repo, keys are chosen by its publisher alone, and an interval-ordered tree is safe.

**Authenticating the global root.** A **light reader** holds only a checkpoint $d$ at a final $t$. It needs two queries, each answered by an untrusted server with a proof checked against $d$:

1. $\mathsf{Heads}(d, P, Q)$: for a set $Q$ of repo names, or all of $P$'s, the entry $(\mathit{pos}_t, H_t)$ of each repo of $P$ in $Q$ that has a head, and no other;
2. $\mathsf{Log}(d)$: the append state $\mathsf{st}(\mathcal{U}_t)$.

The ordering service **authenticates heads and the log** if no efficient adversary makes either query return a wrong value, other than $\mathsf{fail}$, except with probability $\mathbf{Adv}^{\mathsf{dir}}$. An omitted repo or a wrong position counts as wrong. §7 realizes both by storage proofs. Given authenticated heads, an opening of a claimed $\Gamma_t$ is checked leaf by leaf, and a wrong leaf has a fraud proof (Appendix C), because $\Gamma_t$ is a pointwise view of the log.

### 3.3 Reading a slice

**Definition 3.5 (Selector, slice).** A **selector** $S$ is a finite set of triples $(P, Q, I)$: a publisher, a set of its repo names or all of them, and an interval of record keys. The **slice** $\mathcal{G}_t|_S$ is $\mathcal{G}_t$ restricted to those triples.

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{ReadSlice}(d, S) \\
\hline
1: & Z \gets \emptyset;\ \textbf{for each } (P, Q, I) \in S\textbf{, for each } (s \mapsto (i, h)) \in \mathsf{Heads}(d, P, Q)\textbf{ do} \qquad \rhd\ \text{in parallel} \\
2: & \quad (e, \mathit{parent}, \mathit{diff}, \mathit{root}) \gets \mathsf{Get}(h) \\
3: & \quad (D', \pi) \gets \text{opening of } \mathit{root} \text{ on } I \text{ from any source};\ \textbf{require } \mathsf{Check}(\mathit{root}, I, D', \pi) \\
4: & \quad \textbf{for each } k \mapsto n \in D'\textbf{: } Z((P, s), k) \gets \mathsf{Get}(n) \\
5: & \textbf{return } Z \\
\hline
\end{array}
$$

**Cost.** For $r$ repos and $m$ records: the heads (§7), plus $r$ events, $r(h+1) + m/(2^b - 1)$ tree nodes in expectation (Lemma 8.2), and $m$ records, in four round trips.

**History.** The update entries of $\rho$ form its **track**: indices $1..n$ in order, with non-decreasing clock values (Lemma 3.2). $\mathsf{LastAt}$ finds the head as of $t' \le t$ with two log openings:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{LastAt}(\ell, n, \rho, t') \qquad (\ell \text{ the log root at } t;\ n = \mathit{pos}_t(\rho)) \\
\hline
1: & \textbf{if } n = 0\textbf{ then return } \bot \\
2: & (j, l, \pi) \gets \text{from any source};\ \textbf{require } \mathsf{Verify}(\ell, j, l, \pi) \wedge l = (\rho, i, v, t_u) \\
3: & \textbf{if } t_u > t'\textbf{ then require } i = 1;\ \textbf{return } \bot \\
4: & \textbf{if } i < n\textbf{ then } (j', l', \pi') \gets \text{from any source};\ \textbf{require } \mathsf{Verify}(\ell, j', l', \pi') \wedge l' = (\rho, i + 1, \cdot, t'_u) \wedge t'_u > t' \\
5: & \textbf{return } v \\
\hline
\end{array}
$$

**Proposition 3.6 (History reads are sound and complete) [proof].** Given the true $\ell$ and $n$, $\mathsf{LastAt}$ returns $H_{t'}(\rho)$, or $\bot$ if $\rho$ had no head at $t'$, or $\mathsf{fail}$, except with $2\,\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$. An honest source makes it succeed.

_Proof._ Position binding fixes each accepted entry. By Lemma 3.2, entry $i$ has $t_u \le t'$ and entry $i + 1$ does not, so $i$ is the last entry at or before $t'$. $\square$

A **historic slice** at $t'$ reads the heads at $t$, runs $\mathsf{LastAt}$ per repo, and then lines 2–4 on each head it returns.

**Following.** A reader that holds $\Gamma_t$ and a newer $\Gamma_{t'}$ walks the two trees together, skipping equal subtrees. This finds the $c'$ repos whose heads moved, in $O(c' \log)$ nodes. For each such repo, it walks back from the new head to the old one along parents, reading each event's diff. The changes are the diffs themselves: no state trees are compared. **Cost:** the events between the two heads, and $O(\Delta(h+1))$ diff nodes for $\Delta$ changed keys. A light reader without global roots follows the update log instead, appending the new entries to $\mathsf{st}$ and checking the result against $\mathsf{Log}(d')$.

## 4. Stitches and apps

**Definition 4.1 (Stitch).** A **stitch** is a record whose payload includes

$$
\mathit{ref} = (\rho,\ i,\ h,\ k)
$$

naming the event $h$ at position $i$ of repo $\rho$. The key $k$ is a record of $M_h$, or $\bot$ to stitch the event itself, meaning its diff: *this change*. The stitch's other fields belong to whoever stitched: a rank, a tag, a note, a verdict.

$h$ is the name of an event, so a stitch is a link in the global DAG. It runs from the stitching repo's state into another repo's clock. As in Twine [TW], the event that adds a stitch provably happened after the event it stitches (§1.2). Stitches thus give cross-repo happened-before that is visible in the DAG itself. The ordering service additionally places both events in one total order.

**Proposition 4.2 (Stitches are checkable) [proof].** Let $\ell$ be the log root at a final $t$. A reader obtains an entry $(\rho, i, h', t_u)$ at some index $j$ with $\mathsf{Verify}(\ell, j, \cdot, \pi)$. The stitch is **true** if $h' = h$. The reader then takes $\mathsf{Get}(h)$, and opens its root on $[k, k]$, or opens its diff. Except with $\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}} + \mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$, a true stitch yields exactly what $\rho$ committed at position $i$, and a false one names a head $\rho$ never had there.

_Proof._ Lemma 3.2 and position binding give the unique entry for $(\rho, i)$. Lemma 1.1 and opening binding give the content. $\square$

**Cost.** One log opening, of at most $2\lfloor \log_2 M \rfloor$ names, plus one event and $O(h + 1)$ nodes. A stitch is a fact about history, so later updates never make it false. Whether $\rho$ has moved on is one comparison of $i$ with $\mathit{pos}_t(\rho)$.

**Apps.** An **app** is a repo of stitches written by its **curator**, plus a **manifest** record. The manifest says what the app is for, which lenses it serves (§5), and where it is paid [WP2]. The app's head reaches, through its stitches, exactly the events it presents: it is a sub-DAG of the global DAG, cut out and arranged by the curator.

- **Adding, updating, withdrawing.** To add, the curator stitches. To move to a newer version, it re-stitches a later position. To withdraw, it deletes the stitch. Each is an ordinary event of its own repo.
- **No custody, no admission.** An app holds no one's data, and dictates no schema. It may stitch anything, and no publisher needs it.
- **Composition.** An app may stitch other apps. Any repo may stitch: a reply, a derived dataset, an agent's notes on what it read. "App" names a use, not a kind of repo.
- **Changes as content.** Stitching with $k = \bot$ presents a change rather than a state, such as an edit, a correction, or a new reading. This is natural because events carry diffs.

**Validation and moderation.** A **validator** is a repo whose stitches carry verdicts, backed by whatever evidence it has: the data itself, a proof, or a hardware attestation. An app that needs a rule stitches what its validators passed. An app with a moderation set makes its curator a program on the ordering (§7) that writes when its rule is met. A publisher cannot stop a stitch, any more than a web page can stop a link, but it can refuse payment to the app [WP2].

**Corollary 4.3 (Reading an app) [proof].** Reading an app's repo with $\mathsf{ReadSlice}$, and checking each stitch with Proposition 4.2, yields exactly the stitches the curator committed at $t$. For each true stitch, it yields exactly what that stitch names.

Following an app is following its repo (§3.3). A new stitch costs one check, and an unchanged one costs nothing.

## 5. Views

**Definition 5.1 (Lens, view).** A **lens** $L = (S, f)$ is a selector and a deterministic function from slices to states, named $N(\texttt{lens}, L)$. Its **view** at $t$ is $V_L(t) = f(\mathcal{G}_t|_S)$. The input is named by one hash, $\Gamma_t$, so a view is a fact about a named global root: "$L$ at $\Gamma_t$ has root $R$". A lens may take an app as its selector, in which case it reads the records the app's stitches name.

**Proposition 5.2 (Views are determined) [proof].** For a final $t$, every honest party computes the same $\mathsf{Com}(V_L(t))$, except with the probability of Theorem 4.

**Definition 5.3 (Pointwise lens).** $f$ is **pointwise** if $f(Z) = \{\tau(x, r) \mapsto g(r) : (x \mapsto r) \in Z,\ g(r) \neq \bot\}$, with $\tau$ injective in $x$. It is **key-revealing** if $x$ is computable from $\tau(x, r)$.

**Proposition 5.4 (Views follow diffs) [proof].** For a pointwise lens, a diff on keys $X$ updates the view by deleting $\tau(x, Z(x))$ and inserting $\tau(x, Z'(x)) \mapsto g(Z'(x))$ for each $x \in X$. That rewrites $O(|X|(h+1))$ nodes, independent of the size of the slice or the view.

_Proof._ Injectivity of $\tau$ means each view entry comes from exactly one input key. $\square$

An indexer consumes events' diffs directly (§3.3), so keeping a pointwise view current costs only the change. Filters, validation by a predicate on one record, indexes by a field, curation by a set of excluded repos, per-publisher sub-logs, and embeddings under a fixed model are all pointwise and key-revealing. Aggregates are incremental. Joins and general $f$ are neither. The global root is itself the view of a pointwise lens over the update log, whose key is the repo and whose value is its last entry.

**Indexers and claims.** An **indexer** computes views and signs **claims** $(\iota, N(\texttt{lens}, L), t, R)$. It has no authority: anyone can recompute its views, two honest indexers agree exactly, and a wrong pointwise claim has a fraud proof (Appendix C). A reader may trust a claim, cross-check $k$ indexers, hold indexers to account, or recompute the view.

**Embeddings.** An embedding view maps each record to a vector under a model named in the lens. It needs bit-exact inference, such as integer or fixed-point arithmetic **[assumption]**. Its input is $\Gamma_t$, so an embedding of the whole network, or of any app, is named by $(N(\texttt{lens}, L), \Gamma_t)$. Search over such views is Appendix A.

## 6. Security

**Theorem 1 (Binding) [proof].** No adversary controlling every host makes a reader accept, for head $h$, any event, diff or state other than those $h$ names, except with $\mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{bind}}_{\mathsf{Com}}$. _(Lemma 1.1.)_

**Theorem 2 (Authenticity) [proof].** Under Assumption O, every head of $(P, s)$ was set by an entry authored by $P$. _(Line 1 of $\mathsf{Apply}$ keys by author.)_

**Theorem 3 (Linear history) [proof].** The valid updates of a repo form one sequence. The $i$-th sets a head whose event's parent is the head at $i - 1$, and no head occurs twice, except with $\mathbf{Adv}^{\mathsf{bind}}_N$.

_Proof._ The guard requires the parent to be the current head. If $h_i = h_j$ with $i > j$ and $j$ least, the two events are equal, so $h_{i-1} = h_{j-1}$. This contradicts the minimality of $j$, or, for $j = 1$, it gives $h_{i-1} = \bot$. $\square$

**Theorem 4 (Slice soundness) [proof, given opening binding].** For a final $t$ and a selector with $q$ triples, no adversary controlling every host and server makes $\mathsf{ReadSlice}(d, S)$ return anything other than $\mathcal{G}_t|_S$, except with $q\,\mathbf{Adv}^{\mathsf{dir}} + \mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$.

_Proof._ Line 1 gives the true heads, except with $\mathbf{Adv}^{\mathsf{dir}}$. Line 2 accepts only the event named $h$. Line 3 accepts only $M_h|_I$, by opening binding. Line 4 accepts only the named records. $\square$

Theorem 4 gives completeness as well as inclusion. A host can refuse to serve, but it cannot make a partial slice pass as the whole. A historic slice adds $2r\,\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$ for $r$ repos, by Proposition 3.6.

# Part II — Instantiation

## 7. The ordering service as a blockchain

A public chain is an ordering service. Its blocks are the sequence, its timestamps are the clock, and its consensus is $\mathsf{Verify}$. Assumption O holds under the chain's own assumptions. $\delta$ is the finality a reader can check: within about an hour for a full node on a rollup, and the challenge window for a trustless light reader on an optimistic rollup.

The registry is a program whose transition is $\mathsf{Apply}$. Its identifier $\iota$ is the chain ID together with the program address. An entry is a transaction, signed over chain ID, `to` and calldata (EIP-155). Off-chain statements are EIP-712, with $\iota$ in the domain. The program computes $h' = N(e, \mathit{parent}, \mathit{diff}, \mathit{root})$ from a fixed encoding template with SHA-256 **[estimate: a few hundred gas]**.

**Storage.** For each repo, the program stores its head and position. For each publisher, it stores a list of repo names, appended on first write. For the log, it stores the length $M$ and the Merkle mountain range peaks. It does **not** store $\Gamma_t$. Keeping a sparse Merkle root on chain would make every update carry a sibling path, and concurrent updates would invalidate each other's paths. $\Gamma_t$ is instead the fold of the log (Proposition 3.4), computed by anyone.

**Light reads.** $\mathsf{Heads}(d, P, Q)$ is answered by storage proofs, against the header at $t$, of $P$'s repo list and of the head and position of each listed repo in $Q$. $\mathsf{Log}(d)$ is answered by storage proofs of $M$ and the live peaks. This rests on the chain's light-client protocol **[assumption]**. **[estimate]** An update of an existing repo writes four slots, for about 20k gas. A first write creates new slots, on the order of 100k gas.

**Curators** may be keys or programs: a moderator threshold, or a validator the program names. The registry cannot tell them apart.

## 8. Instantiating the Merkle DAGs

$N$ is SHA-256 over a canonical encoding (CIDv1). On chain, the log uses keccak-256 over `abi.encode` (never `encodePacked`), with domain tags.

**Repo states and diffs: Merkle Search Trees** [AT19]. A key's level is $\lfloor \mathsf{lz}(N(k))/b \rfloor$. Each node holds the keys of one level in its gap, and has at most $B_{\max}$ entries. The tree is a function of the map, which gives unique representation. A node is well-formed if its keys are sorted, lie in its gap, have its level, and number at most $B_{\max}$; a reader rejects any node that is not. Only the publisher chooses a repo's keys, so a publisher who grinds them makes only its own repo slow or malformed.

**Lemma 8.1 (Locality) [proof].** Maps differing on $\Delta$ keys have trees that differ in at most $2\Delta(h+1)$ nodes. _(A node changes only if a changed key lies in its closed gap, which is at most two nodes per level per key.)_

**Lemma 8.2 (Openings) [proof].** An opening on an interval holding $m$ keys has at most $(h+1) + \sum_k \mathsf{level}(k)$ nodes. That is at most $(h+1)(m+1)$, and $(h+1) + m/(2^b - 1)$ in expectation for random names. Two accepted openings on one interval are equal. _(The walk on $[k, k]$ follows the same child as the walk on $I$, and well-formedness confines every subtree's keys to its gap.)_

**Lemma 8.3 (Honest nodes are small) [proof, random oracle].** A node holds $m$ or more entries with probability at most $(1 - 2^{-b})^m$. That is about $2^{-95}$ for $b = 4$ and $B_{\max} = 1024$.

**The global root: sparse Merkle trees.** $\mathsf{GCom}$ is a binary tree of fixed depth $2\lambda$ over $N(\text{key})$, where empty subtrees take precomputed default names. Its shape is fixed by the hash function, so no one who chooses keys can raise its height or fill a node. That is why it, rather than a search tree, holds the keys of every publisher. An opening of one key, present or absent, is $2\lambda$ names, compressible by a bitmap of non-default siblings to $O(\log n)$ for $n$ keys. An update rewrites one path. Following walks two trees and skips equal subtrees. Repo names are hashed, so a selector names repos as sets rather than intervals.

**The update log: a Merkle mountain range** [T16]. Leaves are $N(\texttt{leaf}, l)$ and inner nodes are $N(\texttt{node}, \cdot, \cdot)$. The root is $N(\texttt{mmr}, M, \mathit{peaks})$, and $\mathsf{st} = (M, \mathit{peaks})$.

**Lemma 8.4 [proof].** $\mathsf{LCom}$ is binding and position-binding. There are at most $\lfloor \log_2 M \rfloor + 1$ peaks. An opening has at most $2\lfloor \log_2 M \rfloor$ names. An append costs fewer than one merge on average, and at most $\lfloor \log_2 M \rfloor$. The shape is fixed by $M$, so nobody can grind it.

**Costs.**

| Operation | Cost | Status |
|---|---|---|
| Update, on chain | one guard, one name, four slot writes, MMR append (< 2 hashes on average) | Lemma 8.4 [proof]; gas [estimate] |
| Read a slice of $r$ repos, $m$ records | heads, plus $r$ events, $r(h+1) + m/(2^b-1)$ nodes in expectation, and $m$ records; 4 round trips | Lemma 8.2 [proof] |
| Head as of $t'$ | 2 log openings, $\le 4\lfloor \log_2 M \rfloor$ names | Proposition 3.6 [proof] |
| Check a stitch | 1 log opening, 1 event, $O(h+1)$ nodes | Proposition 4.2 [proof] |
| Follow $\Gamma_t \to \Gamma_{t'}$ | SMT diff over $c'$ changed repos, plus the events between heads and their diffs | §3.3 [proof sketch] |
| Follow a pointwise view | $O(\lvert X \rvert (h+1))$ per diff on $X$ keys | Proposition 5.4 [proof] |
| Prove a malformed event | 3 openings | Proposition 2.2 [proof sketch] |
| Fraud proof, pointwise key-revealing lens | 1 view opening plus 1 point read | Proposition C.2 [proof] |

## 9. Scope

**Without full proof:** Proposition 2.2 and following by diffs (sketches); bit-exact embedding models; inclusion within $W$ epochs; gas and proof sizes; the light-client protocol; and Appendices B and C as marked there.

**Omitted, built on this paper:** sealed data and payment [WP2]; curators that are programs; proofs of views too large to recompute; and validators' evidence.

**Operators.** Hosts, indexers, curators and key-release schemes each apply their own policy. Each policy is visible: a withdrawn stitch is an event, a view names its lens, and an unserved node makes a read fail rather than lie. What those policies must be is outside this paper.

# Appendix A — The global index

A web search engine does five things: it crawls, indexes, ranks and serves. Each is a point of trust, and together they make one party the gatekeeper of what can be found. This appendix gives the same function, built for software agents, with none of those points of trust. It is a design on Part I, not part of the protocol, and its results are tagged as in §0.1.

| | A search engine | The global index |
|---|---|---|
| **Crawl** | best effort, never known to be complete | follow $\Gamma_t$: every head, provably complete (Theorem 4) |
| **Index** | private, unauditable | a view of $\Gamma_t$ that anyone may recompute, refute (Prop. A.2), or serve |
| **Rank** | one secret function for everyone | exact similarity, plus signals each reader chooses (A.5) |
| **Serve** | from the engine | by name, from any host |
| **Answer** | take it or leave it | each hit carries a receipt anyone can recheck (A.6) |
| **De-index** | silent | impossible: a missing record is a fraud proof |

### A.1 The clustered view

Fix an embedding model $E : \mathit{Rec} \to \mathbb{Z}^d$, bit-exact (§5), with vectors read as points of $\mathbb{R}^d$ with $\Vert v \Vert \le 1$. Fix a sequence of **centres** $C = (\mu_1, \ldots, \mu_m)$. Let $\kappa(r)$ be the index of the centre nearest $E(r)$, computed in the fixed-point arithmetic of $E$, with ties going to the lowest index.

**Definition A.1 (Global index).** The **global index** under $(E, C)$ over a selector $S$ is the lens $L = (S, f)$, with $E$ and $C$ named in it, whose view is

$$
V_L(t) = \mathsf{GCom}\Big(\big\{\, i \mapsto \mathsf{GCom}\big(\{\, N(x) \mapsto (x,\ E(r)) \;:\; (x \mapsto r) \in \mathcal{G}_t|_S,\ \kappa(r) = i \,\}\big) \,\big\}\Big)
$$

Each record is filed, with its vector, under its nearest centre. The inner root is **cluster** $i$. $S$ may be the whole global state, or an app (§4), which gives a curated index.

The index is named by $(N(\texttt{lens}, L), \Gamma_t)$: one model, one set of centres, one global root. Two layout choices matter:

- **Fixed shape at both levels.** The keys $x = (P, s, k)$ are chosen by every publisher, so a search tree keyed by $(\kappa, x)$ could be ground by anyone who publishes. Clusters and their members are therefore sparse Merkle trees over hashed keys (§8). A cluster is read whole, so intervals are not needed.
- **Clusters are independent.** Each cluster root depends only on the records filed under it, so the index is built and checked one cluster at a time. Nobody needs to hold all of it.

**Proposition A.2 (The index is refutable) [proof, given opening binding and bit-exact $E$].** The lens is pointwise and key-revealing ($x$ is stored with its entry), so Proposition C.2 applies. A wrong root is refuted by one opening and one point read of the input. The point read shows either:

- **a wrong vector:** one evaluation of $E$ on one record;
- **a wrong cluster:** one evaluation of $\kappa$;
- **an omission:** a record $x$ with $\kappa(r) = i$, together with an opening of cluster $i$ showing that $N(x)$ is absent;
- **a forgery:** an entry whose point read returns no record, or a different one.

So de-indexing a record is not a policy an indexer can quietly apply. Any reader who looks can prove it.

**Following.** A changed record moves at most one entry (Proposition 5.4). Keeping the index current costs one evaluation of $E$, plus two sparse Merkle path rewrites, per changed record. An indexer gets the changed records from the diffs of the events between two global roots (§3.3), with no crawl.

### A.2 Who embeds

Embedding is the expensive step, and it is a function of one record. The work therefore splits along two axes, without coordination:

- **By record, once per version.** $E(r)$ depends only on $r$, so it is cached by the record's version $N(\texttt{rec}, r)$ across the whole network. An unchanged record is never embedded twice, and a record cited by a thousand apps is embedded once.
- **By publisher.** A publisher may commit the embeddings of its own repo as a repo, which is a pointwise view of its own data. An indexer takes those vectors and spot-checks them. A wrong vector costs one evaluation of $E$ to refute, against the publisher's own signed head (Theorem 2). This is the verifiable form of a sitemap: the publisher pays to be found, and cannot lie about what it published.
- **By cluster.** Filing is partitioned by $\kappa$, so an indexer may build, serve and vouch for only the clusters it chooses. The top level of the index has $m$ leaves, and anyone can assemble it from per-cluster claims.

### A.3 Coverage and routing

**Definition A.3 (Coverage).** A **coverage** of the index assigns each cluster a radius $\varepsilon_i$, and is **sound** if every vector $v$ of cluster $i$ has $\Vert v - \mu_i \Vert \le \varepsilon_i$. For a query $q$ with $\Vert q \Vert \le 1$, the **bound** of cluster $i$ is $\beta_i(q) = \langle q, \mu_i \rangle + \varepsilon_i$.

A **coverage tree** groups clusters into nodes. Each node covers a contiguous range of cluster indices, and its children partition that range. A node with centre $\nu$ over child clusters or nodes $(\mu_c, \varepsilon_c)$ has radius

$$
\varepsilon = \max_c \big(\Vert \mu_c - \nu \Vert + \varepsilon_c\big)
$$

The coverage tree is a Merkle DAG, and an indexer signs its root alongside its claim for the index.

**Proposition A.4 (Coverage is checkable) [proof].**

1. If cluster $i$ is sound, every $v$ in it has $\langle q, v \rangle \le \beta_i(q)$, and a node is sound whenever its children are.
2. An unsound radius is refuted by one entry of the cluster, opened against the index root, plus a path in the coverage tree.
3. A dropped cluster is visible, because the ranges must partition $1..m$.

_Proof._ (1) By Cauchy–Schwarz, $\langle q, v \rangle \le \langle q, \mu_i \rangle + \Vert v - \mu_i \Vert$, and by the triangle inequality, $\Vert v - \nu \Vert \le \Vert \mu_c - \nu \Vert + \varepsilon_c$. (2) The opening fixes $v$ and its cluster, and the path fixes the claimed radii above it. (3) The reader checks the ranges as it descends. $\square$

A loose radius is not fraud. It only costs the reader extra fetches, and readers choose indexers by how few fetches their coverage costs.

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{Route}(q, j) \qquad (\Vert q \Vert \le 1;\ \text{a coverage tree with root node } n_0) \\
\hline
1: & Q \gets \{n_0\};\ T \gets \emptyset \\
2: & \textbf{while } Q \neq \emptyset\textbf{ do} \\
3: & \quad n \gets \text{the element of } Q \text{ with the highest bound};\ \text{remove it} \\
4: & \quad \textbf{if } |T| = j \wedge \beta(n) < \min_{(x, v) \in T} \langle q, v \rangle\textbf{ then return } T \\
5: & \quad \textbf{if } n \text{ is cluster } i\textbf{ then } Z \gets \text{opening of cluster } i \text{ from any host};\ \textbf{require } \mathsf{Check};\ \text{add } Z \text{ to } T\text{, keeping the } j \text{ best} \\
6: & \quad \textbf{else } \text{add the children of } n \text{ to } Q\text{, each by } \mathsf{Get}\text{, requiring that their ranges partition } n\text{'s} \\
7: & \textbf{return } T \\
\hline
\end{array}
$$

**Proposition A.5 (Routing is exact and complete) [proof].** On a sound coverage, $\mathsf{Route}(q, j)$ returns $j$ entries of highest score in the whole index, or every entry if there are fewer, except with the probability that opening binding fails. It opens no cluster whose bound is below the $j$-th best score.

_Proof._ Line 5 yields exactly cluster $i$: an opening of a sparse Merkle subtree binds every leaf, present or absent. Every unseen entry lies under some element of $Q$, whose bound is at least that entry's score (Proposition A.4), and that bound is at most $\beta(n)$ at line 3. $\square$

This is what a bounded tree over raw vectors could not give: proof that nothing was left out. Completeness comes from the clusters being keyed, while pruning comes from the coverage being geometric.

**Cost [estimate].** At $10^9$ records with $d = 256$ at one byte per coordinate, the index holds about 256 GB of vectors, spread over $m = 10^6$ clusters of about 256 KB each. With a coverage tree of fanout $10^3$, a query embeds once, reads a few tree nodes, and opens a handful of clusters: a few megabytes, fetched by name from any host. **[no proof]** How many clusters a query opens depends on how tight the radii are near it.

### A.4 One index or many

There is no privileged index. Each $(E, C, S)$ is its own lens, and many coexist:

- **Models change.** Re-embedding under $E'$ is a new lens over the same $\Gamma_t$. Old answers stay checkable under the old lens, so no one is forced to migrate.
- **Scope is a selector.** An index over an app's stitches is a curated search engine, and an index over a validator's passes is a filtered one. $\mathsf{Route}$ runs unchanged over several indexes that share $E$, by putting every root node into $Q$.
- **Spam is a scope problem.** An index over all of $\Gamma_t$ holds everything anyone paid to publish. Each head costs a transaction (§7), which bounds the rate, but a reader who wants quality routes over curated scopes. Which scopes to trust is the reader's choice, made visibly, not the engine's choice, made silently.

### A.5 Ranking

$\mathsf{Route}$ ranks by similarity, exactly. Every other ranking signal is a view, so it is recomputable and chosen by the reader:

- **Stitch counts.** The number of stitches into an event, overall or from the apps a reader trusts, is an aggregate view over stitches. It is incremental (§5): the verifiable cousin of counting links.
- **Recency and history.** These come from the update log (§3.1).
- **Verdicts.** Validators' stitches (§4) supply them.

A **ranker** is code that the reader runs on the top candidates from $\mathsf{Route}$, combining similarity with the signals it picked. Rankers are published, named and swappable like lenses. There is no single ranking, and no one can buy a place in yours. **[open]** Global iterative rankings, such as eigenvector centrality over stitches, are not pointwise, and have no fraud proof here.

### A.6 Agents

An agent connects to one server that speaks the same tools over every index: search, get, find similar, follow, and stitch. Three properties follow:

- **Server or client.** By default, an indexer runs $\mathsf{Route}$ on its server and returns the hits. That is cheapest for the agent, and the receipts below keep the answer checkable. An agent that does not want hosts to see its queries runs $\mathsf{Route}$ itself: it embeds on the device and fetches clusters by name, and hosts then see only which clusters it opens. Neither mode changes what an answer proves.
- **Pinned.** An answer cites $(N(\texttt{lens}, L), \Gamma_t, x)$ for each record it used. Another agent, or a person, can reread exactly that data at any later time (§3.3) and check the answer.
- **Writing back.** An agent is a publisher. What it read, it may stitch into its own repo, with notes. Those stitches are signals for the next reader's ranker (A.5), and its memory is held by its owner's key, not by the platform that runs it.

Sealed records [WP2] are indexed by the fields that their publishers leave public. An agent finds them by those fields, and buys the rest.

### A.7 What is open

- **Choosing centres.** How to choose them, and when to recluster. Reclustering is a new lens, at the cost of reading the scope once. This affects cost, not correctness.
- **Bit-exact models** at useful quality, and the cost of evaluating them during a fraud proof on chain.
- **Global rankings** that are not pointwise (A.5).
- **Client-side query privacy** (A.6): how much a host learns from the clusters an agent opens. This is deferred until someone needs it.
- **Paying indexers and hosts** for the clusters they serve. Referral is in [WP2]; per-cluster payment is not designed here.

# Appendix B — Between anchors

Each head costs one entry in the ordering. A sensor or a live stream changes faster than that. Because events are already signed diffs chained by parent, the fix needs no new structure: **a publisher makes events off the ordering, and anchors the latest one.** This appendix is a design sketch, not part of the protocol.

- **Soft events.** $P$ signs events $\varepsilon_1, \ldots, \varepsilon_k$, each the parent of the next, starting from the on-chain head $h_i$. Each has authorship and order within the repo, but not currency.
- **Anchor.** An update carries a field $\mathit{base}$ and the fields of $\varepsilon_k$. The guard requires $\mathit{base} = H(\rho)$, in place of $\mathit{parent} = H(\rho)$, and the head becomes $N(\varepsilon_k)$. The registry still fetches nothing. Positions count anchors.
- **The obligation.** $\varepsilon_k$ descends from $\mathit{base}$, through every event $P$ signed on that base. Faults: **(F1)** two signed events with the same parent, which is a fork; **(F2)** a signed event on base $h_i$ that the anchored chain back to $h_i$ does not contain. F1 is two signatures. F2 is a walk along the anchored chain, linear in $k$ **[open: skip links or an accumulator in the event to make this logarithmic]**.
- **Replay.** Heads still do not repeat while $P$ honours the obligation, since the chain is acyclic (Lemma 1.1). A $P$ that breaks it harms only its own repo, and leaves evidence.
- **Pre-confirmation.** A buyer holding $\varepsilon_j$ knows that $P$ said it, in this order, after $h_i$. After the anchor is final, the buyer finds it in the history, or holds a fault. A bond can pay out on faults, and on a failure to anchor within $\Theta \ge W$ epochs **[no proof]**.
- **Fleets.** Each device gets its own repo, $s = (\mathit{fleet}, \mathit{device})$, because two writers on one repo is fault F1. Delegated device keys are **[open]**.

# Appendix C — Accountable indexers

A **point read** of the input at $x$ returns its value as of $t$, with a proof. For the global state, that is $\mathsf{LastAt}$ for the head and an opening on $[k, k]$. For a log, it is a positional opening.

A **fraud proof** against a claim $(\iota, N(\texttt{lens}, L), t, R)$ is $(y, V', \pi, x, p)$: an opening $(V', \pi)$ of $R$ on $[y, y]$, and a point read $p$ at $x$, where $x$ is recomputed from $y$ when $V' \neq \emptyset$. $\mathsf{CheckFraud}$ computes from the point read what the view should hold at $y$, and returns true if that differs from $V'$.

**Proposition C.2 [proof, given opening binding].** For a pointwise, key-revealing lens: (1) if $R$ is wrong, a fraud proof exists, of one opening and one point read; (2) no efficient adversary produces an accepted fraud proof against a correct $R$.

_Proof._ The two views differ at some key $y$. If $y$ is in the true view, it comes from a unique input key $x$, by injectivity. If not, $y$ reveals the $x$ that would have to produce it. Either way, one point read decides what the view holds at $y$. For soundness, opening binding fixes $V'$, and the point read fixes the input value. $\square$

This covers the global root itself (§5), filters, indexes, sub-logs and embeddings. A watcher who maintains a view finds the key $y$ by walking two trees together. A reader defends against a root shown only to itself by cross-checking a second indexer, or by accepting only published claims. Equivocation, meaning two roots for one lens and one $t$, is self-evidently fraud. Indexers may post bonds that pay out to the first valid proof. Fraud proofs for aggregates, joins and general lenses are **[open]**.

## References

| Key | Reference |
|---|---|
| [AT19] | A. Auvolat, F. Taïani. Merkle Search Trees: Efficient State-Based CRDTs in Open Networks. SRDS 2019 |
| [CER] | Ceramic. Protocol documentation. developers.ceramic.network |
| [FC] | Farcaster. Protocol specification and Snapchain documentation. github.com/farcasterxyz |
| [KFH+24] | M. Kleppmann et al. Bluesky and the AT Protocol: Usable Decentralized Social Media. DIN '24. arXiv:2402.03239 |
| [L78] | L. Lamport. Time, Clocks, and the Ordering of Events in a Distributed System. CACM 21(7), 1978 |
| [MCRDT20] | H. Sanjuán, S. Pöyhtäri, P. Teixeira, I. Psaras. Merkle-CRDTs: Merkle-DAGs meet CRDTs. arXiv:2004.00107 |
| [NIP01] | Nostr. NIP-01. github.com/nostr-protocol/nips |
| [T16] | P. Todd. Merkle Mountain Ranges. OpenTimestamps, 2016 |
| [TG] | The Graph. Documentation. thegraph.com/docs |
| [TW] | Twine Protocol. Documentation. docs.twine.world |
| [WP2] | Fangorn II: sealed data and payment |
