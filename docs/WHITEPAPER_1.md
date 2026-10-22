# Fangorn I: Verifiable Data without a Platform

**Author: Tony Riemer (driemworks@fangorn.network) | Fangorn**

## 0. Introduction

Most data on the web lives on platforms. A platform stores the data, declares which version is current, decides who may write it and who may read it, and runs the search through which it is found. Because a single party performs all of these functions, readers must trust it for all of them: that what they read is what was written, that it is current and complete, and that search shows them what is actually there.

We seek the same functions without the platform. In our setting, data is held by hosts whom nobody needs to trust, yet anyone can check that the data they receive is exactly what its publisher committed, and that it is the current version, or a given past one. Anyone may index the data and serve searches over it without thereby becoming a gatekeeper, since what an index serves can be checked, and a wrong answer proven wrong. Data belongs to no app. An app presents the data it accepts, under a rule of its own choosing, and may withdraw it under another, and both acceptance and withdrawal are matters of public record.

**Part I** presents a general model in two parts:
1. **Data.** A publisher's state is a Merkle DAG, named by its root.
2. **History.** Each publisher's commits form a Merkle clock, and an ordering service places every update into a single total order, providing a logical clock. A registry, run over that ordering, gives each entry its meaning, including which heads each app has accepted to present. Together, data and history define one **global state** at every clock value, any slice of which, current or historic, anyone can read and derive views from without trusting the hosts that serve it. **Indexers** compute and serve views but hold no authority, since a view is a function of public data, and a **watcher** who recomputes a view can prove a wrong one. For the common kinds of view, such as filters, indexes, and embeddings, that proof consists of two openings that anyone can check.

**Part II** instantiates the model:
- the ordering service is a blockchain, which runs the registry and authenticates directories and update logs to light readers;
- the Merkle DAG for states is a Merkle Search Tree, and the commitments to the update log and to each app's log are Merkle mountain ranges.

**Appendix A** sketches how a software agent uses the protocol through a single server, and defines a **semantic CDN**: clustered views and their coverages, by which an agent routes a query to the closest records in the whole network, exactly, and fetches them from any host, without trusting an index.

### 0.1 Our Contributions

We introduce Fangorn, a general-purpose protocol for data in an *agentic* era. Fangorn organizes data into **repos**, each holding one publisher's data. Each repo is a Merkle clock with a single writer (sec. 3.1), and an *ordering service* places the heads of every repo into one total order (sec. 3.2). As each repo has one writer, and the order settles which update comes first, publishers never coordinate with one another, and no CRDT merge is needed. Repos belong to no app, and name no rule. **Validation rules** are published on their own, and anyone may record, as an entry of its own, that a head satisfies one, on evidence of the rule's kind: a proof, an attestation from trusted hardware, or the data itself, checked by the registry. An **app** is a curated composition of validated data, governed at two points. It presents a head of a repo only once it has *accepted* that head, under an *acceptance rule* of its own, which typically requires that the head passed the rules the app names, and adds a selection of the app's own. After that, the app's *exclusion rule* decides what it withdraws. An app may accept data from any publisher, so that many apps may present the same repo, each under its own rules. The registry enforces both rules, so that neither hosts nor indexers need be trusted to do so. A read through the protocol returns only what the app presents, and an indexer that serves excluded data can be proven wrong.
<!-- 
Our contributions are as follows.

1. **Global event ordering** The registry is a deterministic state machine run over an ordering service (Definition 3.1). Whether an update is valid depends on the ordering alone, so anyone who holds the ordering computes the same heads, and no party needs to be trusted to enforce the rules. Every head was set by its publisher, every head an app presents was accepted under the app's rule (Theorem 2), and each repo's history is a single chain in which no head occurs twice, so that a signed update applies at most once (Theorem 3). Together, these results define one global state at every clock value, wherein a past global state is as well defined as the present one.

2. **Reads proven current and complete to a light reader.** A reader holding only a checkpoint of the ordering can read a *slice*: any union of boxes of publishers, repo names, and record keys, as an app presents them or as a publisher committed them. Even if every host and server is adversarial, it obtains exactly that part of the global state, or $\mathsf{fail}$ (Theorem 4). Whereas a signed commit alone proves what a repo holds, this result proves that it is the latest, and that nothing in the slice was left out. The update log, and each app's log of what it accepted and excluded, are committed as Merkle mountain ranges, so that the head of a repo at any past time, and a slice as of any past time, cost only a few logarithmic openings against the latest checkpoint, with no old chain state (Proposition 3.8, Corollary 4.1).

3. **Acceptance and exclusion in the protocol, scoped to an app.** Moderation today happens outside protocols: a host drops data, or an indexer hides it, and nobody can see who decided, nor check that it happened. In Fangorn, admitting data to an app and withdrawing it are both operations of the protocol itself.
   - **Acceptance.** Each app fixes an **acceptance rule** $\alpha_A$, an NP relation like the exclusion rule below. A witness names the exact head it approves, and one step forward from the head the app presented before, so that it authorizes one acceptance, once (§3.2). The registry checks only the witness. Content is checked by **validation rules**, which are published independently of apps and of the data: a validation records, with evidence, that a head satisfies a rule, once, for every app that requires it, and its guarantee is exactly as strong as that evidence, whether the registry's own check, a proof, or an attestation. Anyone who holds a witness may submit it, so an app can pay to present data that its publisher committed for free.
   - **What can be excluded.** An exclusion names one of three things in an app: a whole publisher, one of its repos, or one record key in a repo, and it covers every key of what it names. Each exclusion can be reversed with a **restore** (§3.2).
   - **Who may exclude.** Each app fixes an **exclusion rule** $\chi_A$ when it is created. The rule is an NP relation whose witnesses authorize changes, and it is not tied to the owner: it may require the owner's signature, signatures from a threshold of moderators, or an approval recorded by another program on the ordering. Because the rule is checked against the ordering as it stands when the entry is applied, a list of moderators can change without changing the app, and removing a moderator voids every witness it signed that has not yet been applied (§2). Anyone who holds a valid witness may submit the exclusion.
   - **One witness, one change.** A witness signs a statement naming the registry, the direction (exclude or restore), the target, how many times that target has changed before, and a deadline, so that it authorizes exactly one change, once. It goes stale if the target changes first or the deadline passes, but not merely because the app received unrelated updates (Proposition 3.2).
   - **What an exclusion does.** It changes what the app *presents*, not what was *committed*, nor what any other app presents. Heads, histories, and logs of updates and acceptances are unchanged (Theorems 2, 3), and the ordering keeps a public, ordered record of every exclusion and restore. Exclusions are retroactive: a read of a past state applies the exclusions known now, so that withdrawn data stays withdrawn from history too (§3.2). Every honest reader and indexer applies the exclusions, and a view that still holds an excluded record has a fraud proof (§3.5).
   - **What it does not do.** An exclusion does not delete bytes; rather, it gives hosts an authenticated list of names to drop, after a grace period that leaves room for a restore on appeal (§2). Nor is it where content is checked; that is acceptance, which comes first. It does not control who may read data. Ceasing to accept a repo is a separate matter, which stops its new heads from being presented while leaving what was accepted presented until it is excluded.
   - **What the chain learns.** The ordering holds only names, never content. An exclusion names repos and keys by their hashes, so taking a record down does not write its key to the chain in plain text, although anyone who can guess the key can still check its hash (§5).

4. **Indexers without authority.** A view is a deterministic function of public data, a **lens** (§3.4), so every honest party that computes it obtains the same root (Proposition 3.10). Indexers serve views, but anyone can recompute them. For pointwise, key-revealing lenses, such as filters, curations, indexes, embeddings, and a publisher's own sub-log, a wrong claim admits a **fraud proof** of one opening and one point read, which anyone can check (Proposition 3.15). There is no arbiter, no vote, and no challenge window, and each reader chooses how far to trust an indexer, from trusting it outright to recomputing the view itself (§3.5).

5. **Search by meaning that can be checked.** An embedding view can be served as a **bundle** of shards, each checked against the view's root, so that a reader ranks every record itself, exactly, with proof that nothing was forged or left out, and its query never leaves its device. For a view too large to fetch whole, a **bounded tree** lets a reader find the closest records without fetching every vector, and the search is exact on a sound tree (Lemma 3.17), while a false bound or a forged leaf has a fraud proof (§3.5). Appendix A applies the same bounds one level up, to clustered views, so that an agent finds the closest records across every view on the network, exactly and completely, while opening only the clusters that could hold them.

6. **An instantiation, with costs.** Part II runs the registry as a program on a blockchain (§5). States are Merkle Search Trees, with a bound on node size that turns shape attacks into malformed trees, which harm only the party that chose the keys (§6). The logs are Merkle mountain ranges kept as peaks in contract storage, and a light reader proves heads and logs with storage proofs, requiring no prover. §3.6 gives the cost of every operation.

Fangorn does not keep data available; that is left to hosts, and any storage network may serve as one (§2). Nor does it decide who may *read* data, and sealed data is left to later work (§7). Each result is tagged with its status (§1.1), and §7 lists every claim that lacks a full proof. -->

### 0.2 Related Work and Further Applications

Almost every element of this design is rooted in existing work. What we have not found is a single system that provides all four of the following together: a total order over every publisher's heads; a proof, to a reader holding only a checkpoint, that a slice is current and complete; exclusions that are part of the protocol and scoped to an app; and fraud proofs against indexes. We compare the systems below on those four properties.

**AT Protocol** [KFH+24]. Each account's data is a signed repository, held by a host of the account's choosing and structured as a Merkle Search Tree [AT19], the same structure as in §6. Relays merge every repository into one stream of events, which AppViews then index. A signed commit proves what a repository holds, but not that it is the latest commit, so a reader trusts a relay to have seen every event, and an AppView to index them faithfully. Moderation is performed by labellers and by whoever hosts or indexes the data, outside the protocol. §3.5 takes on the roles of AppView and labeller, and replaces trust in them with checkable views.

**Ceramic** [CER]. Each document is a stream: a log of signed events linked by hashes, which is to say a Merkle clock with one writer. An anchor service places a Merkle root over batches of events on a chain, which proves that an event existed before a given block, a weaker guarantee than proving it is the latest. When a stream forks, nodes pick a branch, with the earliest anchor winning, so a writer who withholds an earlier fork can later reveal it and undo the updates made after it. Nodes sync by reconciling sets over ranges of event identifiers [CIP124], ordered by model, then controller, then stream, much like the two levels of §3.2. Sync reaches the latest events with high probability, but not with proof. Anyone may write documents of any model, there is no moderation in the protocol, and query results are trusted to the node that serves them. Batching makes Ceramic's writes far cheaper than ours; we pay one transaction per update (§5), and that is the price of a head that a reader can prove is current.

**Farcaster** [FC]. Identities and their signing keys are registered on a chain, while messages are held off-chain by a network of nodes. That network first merged messages as CRDTs, and Snapchain now orders them by consensus, so that data and its order live in the same network, with limits on how much each account may store. Fangorn, by contrast, orders only heads and leaves data to untrusted hosts. Publishers here need no admission to write, and an app's acceptance rule, where it lists publishers, plays the role of Farcaster's key registry, but per app.

**Nostr** [NIP01]. Signed events are sent to relays that anyone can run. There is no order across relays and no way to know that a relay returned every event, and each relay moderates for itself.

<!-- **Merkle-CRDTs and IPNS** [MCRDT20, IPNS]. Merkle clocks give a partial order that needs no coordination, and §1.5 makes use of them. Without a total order, however, two replicas cannot tell whether they hold the same latest state. IPNS signs a mutable pointer to a name with a sequence number, but a resolver cannot distinguish a stale record from the latest one.

**Transparency logs** [LLK13, MBB+15]. Certificate Transparency appends to a log and proves inclusion and consistency, while CONIKS proves to each user the current value of its own key in a directory. Our update logs and directories (§3.2) play the same roles, with the ordering service taking the place of gossip as the guard against a log showing different readers different histories. -->

**The Graph and Tableland** [TG, TBL]. Both index data whose order is fixed by a chain. In The Graph, indexers publish proofs of indexing, and an arbitrator settles disputes; Tableland's validators turn SQL statements recorded on a chain into tables. In both, a reader trusts either the node that answers a query or a dispute process with a human in the loop. Proposition 3.15, by contrast, gives a proof that a claim is wrong, which anyone can check, for pointwise views.

<!-- **Storage networks.** Arweave, Filecoin, and data-availability layers keep bytes available, but they do not say which version is current, nor what an app presents. Fangorn leaves availability to hosts (§2), and any of these can serve as one. -->

---

# Part I — The general model

## 1. Preliminaries

### 1.1 Notation

$\lambda$ is the security parameter. "Efficient" means probabilistic polynomial-time in $\lambda$, and $\mathsf{negl}(\lambda)$ is a negligible function. $\mathsf{enc}$ is a canonical, injective encoding of structured values. For any function $F$, $F(x_1, \ldots, x_n)$ means $F(\mathsf{enc}(x_1, \ldots, x_n))$, so two different argument lists never give the same input. A finite partial map from $K$ to $V$ is written $K \rightharpoonup V$.

Each result is tagged with its status:
- **[proof]**: proven in full;
- **[proof sketch]**: the argument is outlined, not complete;
- **[no proof]**: stated without one;
- **[assumption]** or **[estimate]**: taken as given.

§7 lists every claim without a full proof.

**Algorithms** are written in numbered lines, where $x \gets y$ denotes assignment and $\rhd$ begins a comment. The statement $\textbf{require } c$ halts the algorithm if $c$ is false, in which case it returns $\mathsf{fail}$ unless stated otherwise, and a call that returns $\mathsf{fail}$ causes its caller to return $\mathsf{fail}$ as well. "From any source" means from a party that is not trusted, and whatever such a party returns is checked before it is used. Accordingly, $\mathsf{fail}$ says only that the sources asked did not provide what was needed, and a reader may ask others and run the algorithm again.

### 1.2 Names

A **naming function** $N : \{0,1\}^* \to \{0,1\}^{2\lambda}$ gives every value a short name.

**Definition 1.1 (Binding).** Let $\mathbf{Adv}^{\mathsf{bind}}_N(\mathcal{A})$ be the probability that $\mathcal{A}$ outputs $x \neq x'$ with $N(x) = N(x')$. $N$ is **binding** if $\mathbf{Adv}^{\mathsf{bind}}_N(\mathcal{A})$ is negligible for every efficient $\mathcal{A}$.

In other words, naming functions are binding when they are collision resistant (e.g. cryptographic hash functions like SHA-256 are possibly naming functions). Names are unique and verifiable, allowing anyone to check a value received from an untrusted source, since the value is accepted only if it maps (i.e. hashes) to that name.

### 1.3 Merkle DAGs

A directed acyclic graph (DAG) is a set of nodes, each containing a payload and a set of directed edges (links) to other nodes (containing no cycles). A **Merkle DAG** is a DAG where every node's name is the hash of its payload and the names of its children [MCRDT20]. Merkle DAGs satisfy the following properties:
- a node's name can only be computed once its children are defined, so a Merkle DAG must be built from the leaves up
- every node is the root of a sub-DAG
- nodes are immutable

**Definition 1.2 (Node).** A **node** is a pair $n = (v, C)$. Its **payload** is a string $v \in \{0,1\}^*$, and its **links** are a finite sequence $C = (c_1, \ldots, c_m)$ of names. Its name is $N(n) = N((v, C))$. We write $n_\alpha$ for a node with name $\alpha$.

Note: we define links as an ordered sequence rather than a set since we want to be able to 'name' a node based on its payload and links. If the links are not ordered, then there is no canonical name, so we enforce order as a convenience.

**Definition 1.3 (Merkle DAG).** A **Merkle DAG** is a finite set $\mathcal{N}$ of nodes such that:
1. **closure:** for every $(v, C) \in \mathcal{N}$ and every $c$ in $C$, $\mathcal{N}$ contains a node named $c$;
2. **distinct names:** no two different nodes of $\mathcal{N}$ have the same name.

The following terms describe its shape:
- **Links.** Write $n_\beta \to n_\alpha$ if $\alpha$ is a link of $n_\beta$.
- **Descent.** $n_\alpha$ **descends** from $n_\beta$, written $n_\alpha < n_\beta$, if there is a path $n_\beta \to \cdots \to n_\alpha$ of one or more links.
- **Roots.** A **root** of $\mathcal{N}$ is a node that no node of $\mathcal{N}$ links to.
- **The DAG below a name.** For a name $\alpha$ of a node in $\mathcal{N}$, $\mathcal{N}{\downarrow}\alpha$ is the set of nodes reachable from $n_\alpha$, including $n_\alpha$. It is a Merkle DAG, since closure and distinct names carry over to it.

Lemma 1.4 shows that $<$ is a strict partial order, and hence that $n_\alpha$ is the only root of $\mathcal{N}{\downarrow}\alpha$; we therefore call $\alpha$ the root of that DAG, as well as the name of its node.

**Lemma 1.4 (Merkle DAGs are acyclic) [proof, with $N$ modelled as a random oracle].** Let an adversary make $q$ queries to $N$, counting those needed to check the names in its output. It outputs a Merkle DAG with a cycle of links with probability at most $q^2 / 2^{2\lambda}$.

*Proof.* Suppose $\mathcal{N}$ has a cycle $n_{\alpha_1} \to n_{\alpha_2} \to \cdots \to n_{\alpha_k} \to n_{\alpha_1}$. Take the node $n_{\alpha_i}$ on it whose name was queried first. Its input contains the link $\alpha_{i+1}$, indices taken mod $k$. $\alpha_{i+1}$ is the output of a query made later. So some query's input contains the output of a later query. For any one pair of queries, that happens with probability at most $2^{-2\lambda}$. There are at most $q^2$ pairs. $\square$

Binding alone (Definition 1.1) does not yield Lemma 1.4. A cycle requires not a collision but a value that contains its own name, whether directly or through other nodes, and ruling it out requires that outputs of $N$ cannot be predicted before they are computed. This is the formal content of the phrase "built from the leaves up".

**Lemma 1.5 (A name identifies its sub-DAG) [proof].** Let $\mathcal{N}$ and $\mathcal{N}'$ be Merkle DAGs that both contain a node named $\alpha$. If $\mathcal{N}{\downarrow}\alpha \neq \mathcal{N}'{\downarrow}\alpha$, then $\mathcal{N} \cup \mathcal{N}'$ contains two different nodes with the same name, which is a collision of $N$.

*Proof.* Without loss of generality, some node $m$ of $\mathcal{N}{\downarrow}\alpha$ is not in $\mathcal{N}'{\downarrow}\alpha$. Take a path $n_\alpha = m_0 \to m_1 \to \cdots \to m_j = m$ in $\mathcal{N}$. We build, step by step, nodes $m'_0, m'_1, \ldots$ of $\mathcal{N}'{\downarrow}\alpha$, with $m'_i$ named like $m_i$:
- $m'_0$ is the node of $\mathcal{N}'$ named $\alpha$.
- If $m'_i = m_i$, then the two have the same links. So $\mathcal{N}'$ contains a node $m'_{i+1}$ with the name of $m_{i+1}$, by closure, and it is reachable from $n_\alpha$.

If $m'_i = m_i$ for every $i \le j$, then $m = m'_j$ is in $\mathcal{N}'{\downarrow}\alpha$, a contradiction. So for some $i$, $m_i \neq m'_i$, and the two have the same name. $\square$

**Content addressing.** A reader holding a name $\alpha$ can fetch nodes from untrusted sources, starting with $n_\alpha$ and following links, and accepting each node only if it bears the name its parent's link gives. By Lemma 1.5, it thereby obtains exactly the publisher's $\mathcal{N}{\downarrow}\alpha$, unless some source has found a collision. This is content addressing. We write $\mathsf{Get}(\alpha)$ for fetching a value from any source and returning it only if its name is $\alpha$. Every structure in this document, including states, commits, directories, update logs, and views, is a Merkle DAG named by its root.

We commit to a finite map with a Merkle DAG built over its entries. Let $\mathsf{Com}$ be a function that takes a finite map, builds a deterministic (single-root) Merkle DAG whose payloads are the map's entries, and returns its root.

**Definition 1.6 (Map commitment).** $\mathsf{Com}$ is a map commitment if:
1. **binding:** no efficient adversary outputs $D \neq D'$ with $\mathsf{Com}(D) = \mathsf{Com}(D')$, except with negligible probability;
2. **unique representation:** $\mathsf{Com}(D)$ depends only on $D$, not on how $D$ was built;
3. **openings:** keys are totally ordered, and for every interval $I$ of keys there are algorithms $\mathsf{Open}(D, I) \to \pi$ and $\mathsf{Check}(\mathit{root}, I, D', \pi) \in \{0, 1\}$, with:
   - **correctness:** $\mathsf{Check}(\mathsf{Com}(D), I, D|_I, \mathsf{Open}(D, I)) = 1$, where $D|_I$ is the restriction of $D$ to $I$;
   - **opening binding:** no efficient adversary outputs $\mathit{root}$, $I$ and two accepted openings $(D', \pi)$, $(D'', \pi')$ with $D' \neq D''$, except with negligible probability $\mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$.

The second property means that two publishers who reach the same state through different edits commit to the same root. The third lets a reader take part of a map and know that it holds all of that part, without fetching the rest. Since a single key is the interval $[k, k]$, an opening also proves that a key is absent. §6 gives one construction.

We also commit to sequences that only grow. Let $\mathsf{LCom}$ be a function that takes a finite sequence $L = (l_1, \ldots, l_M)$ and returns a root.

**Definition 1.7 (Log commitment).** $\mathsf{LCom}$ is a log commitment if:
1. **binding:** no efficient adversary outputs $L \neq L'$ with $\mathsf{LCom}(L) = \mathsf{LCom}(L')$, except with negligible probability. In particular, the root fixes the length $M$;
2. **positional openings:** there are algorithms $\mathsf{Prove}(L, j) \to \pi$ and $\mathsf{Verify}(\mathit{root}, j, l, \pi) \in \{0, 1\}$ such that $\mathsf{Verify}(\mathsf{LCom}(L), j, l_j, \mathsf{Prove}(L, j)) = 1$, with **position binding**: no efficient adversary outputs $\mathit{root}$, $j$ and accepted openings of position $j$ to two different values, except with negligible probability $\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$;
3. **incremental appends:** there is a small state $\mathsf{st}(L)$, which fixes the length $M$, and algorithms $\mathsf{Root}(\mathsf{st}(L)) = \mathsf{LCom}(L)$ and $\mathsf{Append}(\mathsf{st}(L), l) = \mathsf{st}(L \Vert l)$.

Together, binding and incremental appends let a reader follow a log whose source it does not trust. The reader holds $\mathsf{st}(L)$, receives further entries from any source, appends them, and compares the result with an authenticated root of the longer log; a match proves that it holds every entry, in order. §6 gives one construction.

### 1.4 Relations

A relation $R \subseteq \{0,1\}^* \times \{0,1\}^*$ is a set of pairs $(x, w)$. We call $x$ a **statement** and $w$ a **witness** for $x$.

**Definition 1.8 (NP relation) [AB09, Def. 2.1; G01].** A relation $R$ is an **NP relation** if:
1. **short witnesses:** there is a polynomial $p$ such that $|w| \le p(|x|)$ for every $(x, w) \in R$;
2. **efficient checking:** there is a deterministic algorithm that, given $(x, w)$, decides whether $(x, w) \in R$ in time polynomial in $|x|$.

Its **language** is $\mathcal{L}_R = \{x : \exists w,\ (x, w) \in R\}$, the statements that have a witness. A language is in NP exactly when it is $\mathcal{L}_R$ for some NP relation $R$.

An NP relation separates what is claimed from the evidence for it. A witness may be hard to produce, yet anyone can check it quickly, and the relation is indifferent to how it was found. Validation rules, and an app's acceptance and exclusion rules, are NP relations (§2), wherein the statement names one change to what the app presents, and the witness is evidence that the change is authorized, such as the owner's signature on the statement, signatures from a threshold of moderators, or a proof about the content.

### 1.5 Merkle clocks and logical clocks

A **Merkle clock** records events in a Merkle DAG, so that the DAG itself shows which events came before which [MCRDT20]. It grows by a single rule: to record an event, a writer makes a new node whose payload is the event and whose links are the names of the DAG's current roots, so that the new node becomes the only root. Each node therefore links, directly or through others, to every event its writer had seen when it was made. Two writers who record events without seeing each other's produce two nodes that do not reach each other; merging their DAGs keeps both nodes as roots, and the next event links to both.

**Definition 1.9 (Merkle clock).** A **Merkle clock** is a Merkle DAG whose payloads are events, and whose every node was added by the rule above. Write $n_a$ for the node of event $a$. Event $a$ **happened before** event $b$, written $a \prec b$, if $n_a < n_b$.

A Merkle clock gives a partial order, in the sense of Lamport's happened-before relation [L78], that anyone can check from the nodes alone. A single writer's events form a chain, while events of different writers may be concurrent, in which case neither happened before the other. A system with several writers must nonetheless decide what its data is when writes are concurrent. One way to do so without a central server is through CRDTs, data types whose concurrent updates always merge to the same result [MCRDT20]. We take another path: each repo has one writer, and an **ordering service** places every writer's updates into one total order and decides when they are final.

**Definition 1.10 (Ordering service).** An ordering service maintains a sequence of entries $\mathcal{O} = (o_1, o_2, \ldots)$ and a logical clock, and offers:
- $\mathsf{Submit}(o)$, which proposes an entry;
- $\mathsf{Read}(t)$, which returns the prefix of $\mathcal{O}$ up to clock value $t$;
- $\mathsf{Verify}(d, \mathcal{O}')$, which decides whether $\mathcal{O}'$ is a valid extension of the checkpoint $d$.

Each entry $o_i = (t_i, a_i, d_i, \mathit{op}_i)$ has a clock value $t_i$, an author $a_i$, a **destination** $d_i$, and an operation $\mathit{op}_i$. The clock value is assigned by the ordering service, while the destination (the identifier of the registry to which the entry is addressed, §3.2) and the operation are chosen by the author. An **epoch** is $e(t) = \lfloor t / \eta \rfloor$ for a fixed length $\eta$.

**Assumption O (Ordering).**
1. **Agreement:** all honest parties obtain the same sequence, up to a finality delay $\delta$: an entry more than $\delta$ clock steps old is never revised.
2. **Authorship:** for every efficient adversary, the probability that it outputs an entry $(t, a, d, \mathit{op})$ accepted by $\mathsf{Verify}$, where $a$ never signed the pair $(d, \mathit{op})$, is negligible.
3. **Clock:** clock values never decrease along the sequence.

The ordering service thus turns the publishers' partial orders into one total order, and its clock defines when things happen.

## 2. Data

A (typed) **record** is a pair $r = (\theta, v)$ of a type and a payload, where the payload is a map from field names to values. Values may be scalars, names of other nodes, or keys of other records.

A **state** is a finite map from keys to records,

$$
M : K \rightharpoonup \mathit{Rec}
$$

A key is chosen by the publisher and identifies an entity across versions, while the **version** of a record is its name, $N(\texttt{rec}, r)$. A state is a Merkle DAG whose leaves are records, and whose root is

$$
\mathsf{root}(M) = \mathsf{Com}\big(\{\, k \mapsto N(\texttt{rec}, M(k)) : k \in \mathrm{dom}(M) \,\}\big)
$$

A **repo** is one publisher's data. It is identified by $\rho = (P, s)$, where $P$ is the publisher, an author of the ordering (§1.5), and $s$ a name it chooses. Only $P$ writes it (§3.1). A repo belongs to no app: any number of apps may present it, and it exists whether or not any does. Nor does a repo, or an update to it, name any rule its data should satisfy: a publisher commits data, and nothing more.

A **validation rule** is a pair

$$
V = (n_V,\ \nu_V)
$$

where $\nu_V$ is an NP relation over statements about one head of one repo, and $n_V = N(\texttt{rule}, \nu_V)$ is its name. A statement names the registry, the rule, the repo, the position $i_0$ at which the rule last validated the repo, and the position $i$ and head $h$ to validate. A witness is evidence that the state committed by $h$ satisfies the rule. Naming $i_0$ lets the evidence be incremental, showing that $h$ satisfies the rule given that the head at $i_0$ did, at a cost that grows with the change rather than with the state.

What a rule checks is its own affair: a schema, constraints that relate records, a format, or terms that only a person or a model can judge. How it checks is its own as well. The witness may be:
- **the data itself,** that is, the records the rule reads together with their openings against the head's state, which the registry checks directly;
- **a succinct proof** that the state satisfies the rule, which the registry verifies;
- **an attestation:** a signature from a key whose hardware attests that it runs the rule's code, or simply a signature from a validator whom the rule names.

Each kind of witness is exactly as strong as its evidence: a check by the registry is as strong as the ordering, a proof as its proof system, and an attestation as the hardware and the signer. Because a rule is named by what it checks, two parties that publish the same rule publish the same name, and nobody owns it. A rule is published once, and checked against data as often as anyone holds a witness for it, as an entry of its own (§3.2), separate from the update that committed the data.

An **app** is a tuple

$$
A = (n_A,\ o_A,\ \alpha_A,\ \chi_A)
$$

fixed when the app is created:
- $n_A$ is its name, which identifies it;
- $o_A$ is its owner, an author of the ordering;
- $\alpha_A$ is its **acceptance rule**, an NP relation whose witnesses authorize the app to present a head of a repo. A statement names one step: the registry, the app, the repo, the position the app presented before, the position and head it is to present, and a deadline, possibly none (§3.2);
- $\chi_A$ is its **exclusion rule**, an NP relation whose witnesses authorize excluding data from the app, or restoring it. A statement names one change: the registry, its direction, what it excludes or restores, how many changes that exclusion has had before, and a deadline, possibly none (§3.2).

We write $A$ both for the tuple and for its name.

**What an app does.** An app composes data that has passed validation, and that it chooses to present. It holds no data, and it dictates no schema. It plays two roles, at two points:
- **Acceptance.** The app presents a head of a repo only once a witness under $\alpha_A$ accepts it, and it moves forward through the repo's history only by further acceptances. The repo's publisher may meanwhile commit heads that the app never presents. An acceptance rule may read the registry, and its commonest form requires that the head has been validated under rules the app names, then adds a selection of the app's own: any repo so validated, the repos of publishers that $o_A$ lists, or those that a curator approves. Apps that require the same rule rely on the same validations, so that data validated once may be presented by every app that requires it, and an app adopts or drops a rule by changing what it accepts, without touching any data.
- **Presentation.** After acceptance, $\chi_A$ decides what the app withdraws (§3.2). An exclusion withdraws data from one app. It changes neither the repo that holds the data, nor its validations, nor what any other app presents.

A rule on single records may also be checked at read time, by a lens (§3.4), which anyone may do and which requires nothing of the registry.

**Who may accept, and who may exclude, is left open.** Each rule may require the owner's signature, the signatures of a threshold of moderators or validators, a proof checked by a program on the ordering, or an approval recorded in the ordering by some other program, and it may refer to the ordering. A rule such as "the statement, signed by a key that $o_A$ currently lists" thus lets the set of moderators, validators, or admitted publishers change without changing the tuple. Such a list lives in the ordering, outside the registry, for example in the storage of a program that $o_A$ controls (§5). Because a rule is evaluated when the entry is applied, over the ordering before it, it checks the signer against the list as it stands at that moment, not against a fixed set. Removing a key therefore voids every witness it signed that has not yet been applied, including any it signed in advance, whereas a rule over a fixed set of keys offers no such revocation.

**Who pays.** Anyone who holds a witness may submit an acceptance (§3.2). An app can therefore pull data that a publisher committed for its own reasons, and pay for the acceptance itself, while a publisher that wants to be presented can carry the acceptance in its own update, as one entry. When every publisher of an app does the latter, under a rule that lists them, the app behaves as one that owns its publishers' data. A validation, likewise, is paid for once, by whoever submits it, and serves every app that requires its rule. A publisher takes no part in a pull, and whether an app may present data its publisher did not submit is a matter of the data's license, not of the protocol. Data that only some may read is sealed, which is left to later work (§7).

Every node of every DAG is held by untrusted hosts and fetched by name, and what a host keeps or drops is its own decision. A host chooses which apps it serves, and exclusions (§3.2) give it an authenticated list of what each app no longer presents. Because a node can be shared with data that is still presented, a host should drop only names that no state it serves reaches, and it should keep excluded nodes for a grace period after the exclusion, so that a restore, for example on appeal, can still find them. A publisher remains responsible for pinning its own data, and a restore after the grace period is best effort: data that no host serves causes a read to $\mathsf{fail}$ (Theorem 4), never to return something else. Unpinning is otherwise a matter for implementations.

## 3. History and state

### 3.1 Each repo is a Merkle clock

A **commit** is an event $\gamma = (e, \mathit{parent}, \mathit{root})$:
- $e$ is the epoch in which it was made, which the registry checks against the ordering's clock (§3.2);
- $\mathit{parent}$ is the name of the previous commit, or $\bot$, which the registry also checks;
- $\mathit{root}$ is the root of the new state.

A repo's commits form a Merkle clock with one writer, and hence a chain. A repo's **head** is the name $N(\gamma)$ of its current commit. For a head $h$, $M_h$ is the state committed by its commit's root, and $M_\bot = \emptyset$. A reader holding a head thereby holds, by name, the repo's whole history and its current state.

What the Merkle clock cannot say on its own is whether a head is the *latest*. A host can withhold newer commits, and nothing in the DAG reveals that it has done so. It is the ordering service that answers this question.

### 3.2 The ordering service orders heads

The ordering service stores entries but does not interpret them. Their meaning is given instead by a deterministic state machine run over the ordering, the **registry**, whose state holds everything a reader needs to know about repos, rules, apps, and what each app presents. A registry has two parameters, fixed when it is deployed: an **identifier** $\iota$ that no other registry shares, such as a chain's identifier together with a program's address, and a **window** of $W \ge 1$ epochs.

**Definition 3.1 (Registry).** A **registry state** is a tuple

$$
R = (\mathcal{R},\ \mathcal{A},\ \mathcal{H},\ \mathcal{V},\ \mathcal{D},\ \mathcal{X},\ \mathcal{C},\ \mathcal{U},\ \mathcal{L})
$$

where:
- $\mathcal{R}$ maps a rule's name $n_V$ to its rule $V$ (§2);
- $\mathcal{A}$ maps an app's name $n_A$ to its tuple $A$ (§2);
- $\mathcal{H}$ maps a repo $\rho$ to its position and its head, $(\mathit{pos}, h)$, with $\mathcal{H}(\rho) = (0, \bot)$ for a repo never written;
- $\mathcal{V}$ maps a rule $V$ and a repo $\rho$ to $(n, i, h)$: the number $n$ of valid validations of $\rho$ under $V$ so far, and the position $i$ and head $h$ last validated, with $\mathcal{V}(V, \rho) = (0, 0, \bot)$ if there are none;
- $\mathcal{D}$ maps an app $A$ and a repo $\rho$ to $(n, i, h)$: the number $n$ of valid acceptances of $\rho$ in $A$ so far, and the position $i$ and head $h$ that $A$ last accepted, with $\mathcal{D}(A, \rho) = (0, 0, \bot)$ if there are none;
- $\mathcal{X}$ maps an app to its set of current **exclusions**: a whole publisher $P$, a repo $(P, s)$, or one record key $k$ in a repo, $(P, s, k)$. An exclusion **covers** every key of what it names;
- $\mathcal{C}$ maps an app and an exclusion $X$ to the number of valid $\mathsf{exclude}$ and $\mathsf{restore}$ entries for $X$ so far, with $\mathcal{C}(A, X) = 0$ for an exclusion never made;
- $\mathcal{U}$ is the **update log**, a sequence of entries, one for each valid update of any repo;
- $\mathcal{L}$ maps an app to its **app log**, a sequence of entries, one for each valid acceptance, exclusion, and restore in that app, and a rule to its **rule log**, one entry for each valid validation under that rule.

The initial state $R_0$ consists of empty maps and an empty log. One ordering may serve many registries. For a registry $\iota$, let $\mathcal{O}_\iota$ be the subsequence of $\mathcal{O}$ consisting of entries with destination $d = \iota$, and $\mathsf{Read}_\iota(t)$ the corresponding subsequence of $\mathsf{Read}(t)$. The registry $\iota$ is a function of $\mathcal{O}_\iota$ alone, and since the destination is fixed within it, we write an entry of $\mathcal{O}_\iota$ as $o = (t, a, \mathit{op})$. Each such entry carries one of seven operations.

The destination is not checked by $\mathsf{Apply}$; rather, it selects the entries on which $\mathsf{Apply}$ is run. Entries are bound to it by Assumption O.2: an entry of $\mathcal{O}_{\iota'}$ with author $a$ and operation $\mathit{op}$ requires a signature of $a$ on $(\iota', \mathit{op})$, and a signature on $(\iota, \mathit{op})$ for $\iota \neq \iota'$ is not one. Except with negligible probability, then, every entry of $\mathcal{O}_{\iota'}$ was addressed to $\iota'$ by its author, and no entry made for $\iota$ is also an entry of $\mathcal{O}_{\iota'}$. A witness $w$, however, is not an entry. It is produced apart from the ordering, and any author may carry it, so Assumption O.2 says nothing about where $w$ is used, and the binding must instead reside in the statement it witnesses: $\iota$ is the first component of every statement: $(\iota, V, \rho, i_0, i, h)$ for a validation, $(\iota, A, \mathsf{accept}, \rho, i_0, i, h, t_x)$ for an acceptance, and $(\iota, A, \mathit{op}, X, k, t_x)$ for an exclusion or a restore (lines 4, 6, 8, and 11).

The transition $\mathsf{Apply}$ runs $o$ against $R$:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{Apply}(R, o) \qquad (o = (t, a, \mathit{op}) \in \mathcal{O}_\iota;\ \text{a failed } \textbf{require} \text{ returns } R \text{ unchanged}) \\
\hline
1: & \textbf{case } \mathit{op} = \mathsf{app}(A)\textbf{: require } a = o_A \wedge A \notin \mathrm{dom}(\mathcal{A});\ \mathcal{A}(n_A) \gets A;\ \mathcal{X}(A) \gets \emptyset;\ \mathcal{L}(A) \gets () \\
2: & \textbf{case } \mathit{op} = \mathsf{update}(s, e, \mathit{parent}, \mathit{root}, \mathit{Val}, \mathit{Acc})\textbf{: } P \gets a;\ (i, h) \gets \mathcal{H}(P, s);\ \textbf{require } \mathit{parent} = h \wedge e(t) - W \le e \le e(t) \\
3: & \quad h' \gets N(e, \mathit{parent}, \mathit{root});\ \mathcal{H}(P, s) \gets (i + 1, h');\ \mathcal{U} \gets \mathcal{U} \Vert (P, s, i + 1, h', t);\ \textbf{for each } (V, w) \in \mathit{Val}\textbf{: } R \gets \mathsf{Apply}(R, (t, a, \mathsf{validate}(V, P, s, i + 1, h', w)));\ \textbf{then for each } (A, t_x, w) \in \mathit{Acc}\textbf{: } R \gets \mathsf{Apply}(R, (t, a, \mathsf{accept}(A, P, s, i + 1, h', t_x, w))) \\
4: & \textbf{case } \mathit{op} = \mathsf{accept}(A, P, s, i, h, t_x, w)\textbf{: } (n, i_0, \cdot) \gets \mathcal{D}(A, P, s);\ \textbf{require } A \in \mathrm{dom}(\mathcal{A}) \wedge i_0 < i \wedge (P, s, i, h, \cdot) \in \mathcal{U} \wedge t \le t_x \wedge ((\iota, A, \mathsf{accept}, (P, s), i_0, i, h, t_x), w) \in \alpha_A \\
5: & \quad \mathcal{D}(A, P, s) \gets (n + 1, i, h);\ \mathcal{L}(A) \gets \mathcal{L}(A) \Vert (\mathsf{accept}, P, s, n + 1, i, h, t) \\
6: & \textbf{case } \mathit{op} = \mathsf{exclude}(A, X, t_x, w)\textbf{: require } A \in \mathrm{dom}(\mathcal{A}) \wedge X \notin \mathcal{X}(A) \wedge t \le t_x \wedge ((\iota, A, \mathsf{exclude}, X, \mathcal{C}(A, X), t_x), w) \in \chi_A \\
7: & \quad \mathcal{X}(A) \gets \mathcal{X}(A) \cup \{X\};\ \mathcal{C}(A, X) \gets \mathcal{C}(A, X) + 1;\ \mathcal{L}(A) \gets \mathcal{L}(A) \Vert (\mathsf{exclude}, X, \mathcal{C}(A, X), t) \\
8: & \textbf{case } \mathit{op} = \mathsf{restore}(A, X, t_x, w)\textbf{: require } A \in \mathrm{dom}(\mathcal{A}) \wedge X \in \mathcal{X}(A) \wedge t \le t_x \wedge ((\iota, A, \mathsf{restore}, X, \mathcal{C}(A, X), t_x), w) \in \chi_A \\
9: & \quad \mathcal{X}(A) \gets \mathcal{X}(A) \setminus \{X\};\ \mathcal{C}(A, X) \gets \mathcal{C}(A, X) + 1;\ \mathcal{L}(A) \gets \mathcal{L}(A) \Vert (\mathsf{restore}, X, \mathcal{C}(A, X), t) \\
10: & \textbf{case } \mathit{op} = \mathsf{rule}(V)\textbf{: require } n_V = N(\texttt{rule}, \nu_V) \wedge n_V \notin \mathrm{dom}(\mathcal{R});\ \mathcal{R}(n_V) \gets V;\ \mathcal{L}(V) \gets () \\
11: & \textbf{case } \mathit{op} = \mathsf{validate}(V, P, s, i, h, w)\textbf{: } (n, i_0, \cdot) \gets \mathcal{V}(V, P, s);\ \textbf{require } V \in \mathrm{dom}(\mathcal{R}) \wedge i_0 < i \wedge (P, s, i, h, \cdot) \in \mathcal{U} \wedge ((\iota, V, (P, s), i_0, i, h), w) \in \nu_V \\
12: & \quad \mathcal{V}(V, P, s) \gets (n + 1, i, h);\ \mathcal{L}(V) \gets \mathcal{L}(V) \Vert (\mathsf{validate}, P, s, n + 1, i, h, t) \\
13: & \textbf{return } R \\
\hline
\end{array}
$$

The $\textbf{require}$ on each line is the operation's **guard**. If it holds, $o$ is **valid**; otherwise $\mathsf{Apply}$ returns $R$ unchanged, and $o$ is **invalid**. An update whose own guard holds is valid, and the validations and then the acceptances it carries are applied in turn, each valid or invalid on its own, so that a failed one never undoes the update. A deadline $t_x = \infty$ means that there is none.

**Updates.** $\mathsf{update}(s, e, \mathit{parent}, \mathit{root}, \mathit{Acc})$, authored by publisher $P$, moves repo $(P, s)$ from its head $h$ to the head $h' = N(e, \mathit{parent}, \mathit{root})$ of a new commit whose parent is $h$. $\mathsf{Apply}$ computes that name from the commit's three fields, and never fetches a commit or a state. Because an update applies only while its parent is the head, and no head occurs twice (Theorem 3), a signed update applies at most once: replayed after the repo has moved on, it fails the guard, even if the repo has since returned to the same state through another commit, and returning to an old state therefore takes a fresh commit. No rule or app is consulted, and an update names neither. Any author may commit to its own repos, at its own cost, and an update by itself changes what no app presents. An update may carry validations and acceptances of the head it sets, so that a publisher can do all three in one entry, but these are separate operations, applied after the update; they are carried only to save an entry.

**Validations.** A rule is published by the entry $\mathsf{rule}(V)$, by anyone, once. $\mathsf{validate}(V, P, s, i, h, w)$ then records that the head $h$ at position $i$ of $\rho = (P, s)$ satisfies $V$, on the evidence of $w$. Like an acceptance (below), it moves forward only, from the position $i_0$ last validated, and it may skip positions: a head that fails the rule is never validated, and the next validation proceeds from the last head that passed. Anyone who holds a witness may submit it, and a validation, once made, serves every app that requires the rule. A validation records a fact about committed content, which no later entry revokes, so its statement has no deadline; whether an app still relies on the rule is a matter for that app's acceptance rule.

**Acceptances.** $\mathsf{accept}(A, P, s, i, h, t_x, w)$ moves what app $A$ presents of repo $\rho = (P, s)$ forward, from the position $i_0$ it last accepted to a later position $i$ of $\rho$'s history, whose head $h$ the update log fixes (Lemma 3.5). It may skip positions, so that an app can accept a repo that changes faster than the app can check it, but it never moves back, so the heads that $A$ presents of $\rho$ are a subsequence of $\rho$'s history (Theorem 3). Anyone who holds a witness may submit it. The witnessed statement $(\iota, A, \mathsf{accept}, \rho, i_0, i, h, t_x)$ names the position that $A$ presented before, so that, like the count in an exclusion's statement, it authorizes one step, once: after any other acceptance of $\rho$ in $A$, its $i_0$ is stale. It names $h$ as well as $i$, so that the witness binds the content it approves, and a validator signs the very head it inspected. To stop presenting new data of $\rho$, $A$ stops accepting it; to withdraw what it has presented, it excludes it.

Admission is a special case. If $\alpha_A$ accepts a statement signed by a publisher that $o_A$ lists, and each such publisher carries the acceptance in each of its updates, then $A$ presents exactly the latest heads of its admitted publishers, as an app that owned its publishers' data would. Removing a publisher from the list stops new acceptances, while its presented data remains until it is excluded.

**Exclusions.** Exclusions and restores may be authored by anyone who holds a witness for that change. The witnessed statement $(\iota, A, \mathit{op}, X, k, t_x)$ names the registry, the direction $\mathit{op}$, the number $k = \mathcal{C}(A, X)$ of changes to $X$ before it, and a deadline $t_x$ after which the witness is void. A witness thus authorizes one change, in one direction, once, in one registry (Proposition 3.2), and it goes stale when $X$ changes first or its deadline passes. Binding the statement to $|\mathcal{L}(A)|$ instead would make every pending witness go stale on every change to the app. As §2 allows, $\chi_A$ may read the ordering before the entry, so that who may exclude can change over time, and a witness then also goes stale when the rule stops accepting it, for example when its signer is no longer listed. An exclusion may name any publisher, repo, or key, whether or not $A$ has accepted it, so that an app can refuse data before it is offered. Finally, an exclusion names one key rather than a range of keys, so that one authority's exclusion never blocks another's exclusion of a different key.

The **registry at $t$**, $R_t$, is the result of applying $\mathsf{Apply}$ to the entries of $\mathsf{Read}_\iota(t)$ in order, starting from $R_0$. Every quantity below is read from it:
- $H_t(\rho)$ is the **head** of repo $\rho$ at $t$ (§3.1), and $\mathit{pos}_t(\rho)$ its **position**: $(\mathit{pos}_t(\rho), H_t(\rho)) = \mathcal{H}(\rho)$ in $R_t$. For a repo never written, they are $0$ and $\bot$;
- $(n_t(A, \rho), \mathit{pos}_t(A, \rho), H_t(A, \rho)) = \mathcal{D}(A, \rho)$ in $R_t$ are the number of acceptances of $\rho$ in $A$, and the position and head that $A$ **accepted**;
- $\mathcal{X}_t(A)$ is $\mathcal{X}(A)$ in $R_t$, and $\mathcal{C}_t(A, X)$ is $\mathcal{C}(A, X)$ in $R_t$;
- $(n_t(V, \rho), \mathit{pos}_t(V, \rho), H_t(V, \rho)) = \mathcal{V}(V, \rho)$ in $R_t$ are the number of validations of $\rho$ under $V$, and the position and head last **validated**;
- $\mathcal{U}_t$ is $\mathcal{U}$ in $R_t$, and $\mathcal{L}_{A,t}$ and $\mathcal{L}_{V,t}$ are $\mathcal{L}(A)$ and $\mathcal{L}(V)$ in $R_t$.

**Cost.** A transition changes a constant number of map entries and appends at most one log entry, except that an update also applies each validation and acceptance it carries. Its guard costs a constant number of lookups, together with one name and one epoch for an update, a lookup in $\mathcal{U}$ for a validation or an acceptance, and checking $w$ under $\nu_V$, $\alpha_A$, or $\chi_A$, together with one lookup of $\mathcal{C}(A, X)$, whose parity is membership in $\mathcal{X}(A)$ (Proposition 3.2), for an exclusion or a restore.

The registry is a single abstract machine, but an instantiation may split it, for example into one contract that holds $\mathcal{H}$ and $\mathcal{U}$ a second that holds $\mathcal{R}$, $\mathcal{V}$, and the rule logs, and a third that holds $\mathcal{A}$, $\mathcal{D}$, $\mathcal{X}$, $\mathcal{C}$, and the app logs (§5). It may also store only commitments to parts of it, provided it computes the same transitions.

Invalid entries change nothing. The **history** of a repo is the sequence of heads $h_1, h_2, \ldots$ set by its valid updates, wherein $h_i$ is at **position** $i$. Its **accepted history** in app $A$ is the sequence of heads set by its valid acceptances in $A$, and its **validated history** under rule $V$ the sequence set by its valid validations under $V$.

Validity, and hence $R_t$, is a function of $\mathcal{O}$ alone. Anyone who holds the ordering computes the same heads, and no party needs to be trusted to enforce the rules.

**Commit epochs.** The guard on line 2 ties a commit's epoch to the ordering's clock. A publisher makes a commit before the ordering includes it, and does not choose when that happens, so the window allows $W$ epochs of lag; requiring equality would invalidate every update that crosses an epoch boundary. A deployment sets $W$ by time, such that $W\eta$ covers the longest inclusion delay it intends to survive, for example a day on a rollup whose forced inclusion takes that long (§5). An update that lands later is invalid: the head stays where it was, and the publisher commits again under the current epoch. Whoever orders entries can delay an update, which is the liveness that Assumption O leaves to the ordering, but cannot make a late update land. Acceptances carry no epoch, since the head they name is already fixed by the log. Since every head is the name of a commit for which its publisher signed, only $P$ can make $(P, s)$ unreadable, whether by withholding a commit or its state or by committing a malformed one (§6), and doing so harms only that repo, and the apps that accept it. A view over an unreadable repo can be neither computed nor refuted (Proposition 3.15).

**The global state.** The **committed state** at clock value $t$ is the map

$$
\hat{\mathcal{G}}_t(\rho, k) = M_{H_t(\rho)}(k)
$$

over every repo $\rho$ and key $k$, undefined wherever $M_{H_t(\rho)}$ is. It records what was written. What app $A$ has **accepted** at $t$ is the map $\hat{\mathcal{G}}^A_t(\rho, k) = M_{H_t(A, \rho)}(k)$.

A **context** $c$ is either an app $A$ or $\bot$. The **presented state** in context $c$ as of $t' \le t$, read at $t$, is

$$
\mathcal{G}^t_{t'}[A](\rho, k) = \begin{cases} \hat{\mathcal{G}}^A_{t'}(\rho, k) & \text{if no exclusion in } \mathcal{X}_t(A) \text{ covers } (P, s, k), \text{ for } \rho = (P, s) \\ \text{undefined} & \text{otherwise} \end{cases}
\qquad
\mathcal{G}^t_{t'}[\bot] = \hat{\mathcal{G}}_{t'}
$$

The **global state** in context $c$ is $\mathcal{G}_t[c] = \mathcal{G}^t_t[c]$. Context $\bot$ is each publisher's own word, to which no app's acceptances or exclusions apply; context $A$ is what $A$ presents. Exclusions are **retroactive**: a read at $t$ of the state as of an earlier $t'$ applies the exclusions known at $t$, not those known at $t'$. $\mathcal{G}_{t'}[A]$ itself does not change, since it applies $\mathcal{X}_{t'}(A)$, and a claim about it is judged against the heads and exclusions as of $t'$ (§3.5). Throughout what follows, a slice, view, or read refers to the presented state in some context.

**Proposition 3.2 (Exclusions are explicit) [proof].** For every app $A$ and $t' \le t$, $\mathcal{G}^t_{t'}[A]$ agrees with $\hat{\mathcal{G}}^A_{t'}$ on every key that no exclusion in $\mathcal{X}_t(A)$ covers, and is undefined on every key that one covers. Every change to $\mathcal{X}_t(A)$ is an entry of the ordering with a witness under $\chi_A$ for exactly that change. Let $o_1, o_2, \ldots$ be the valid $\mathsf{exclude}$ and $\mathsf{restore}$ entries for an exclusion $X$ of $A$, in order. Then $o_j$ is an $\mathsf{exclude}$ if $j$ is odd and a $\mathsf{restore}$ if $j$ is even, its witness is for $(\iota, A, \mathit{op}_j, X, j - 1, t_x)$ with $t_x$ no earlier than its clock value, its log entry carries the count $j$, and no statement is accepted twice.

*Proof.* The first claim is the definition of $\mathcal{G}^t_{t'}[A]$. $\mathcal{X}(A)$ and $\mathcal{C}(A, X)$ change only on lines 7 and 9, through valid $\mathsf{exclude}$ and $\mathsf{restore}$ entries. Each such entry for $X$ adds one to $\mathcal{C}(A, X)$, and no other entry changes it. So before $o_j$, $\mathcal{C}(A, X) = j - 1$, and by the guard on line 6 or 8, $o_j$ carries a witness for $(\iota, A, \mathit{op}_j, X, j - 1, t_x)$ with $t_x$ no earlier than its clock value. Line 7 or 9 logs the count after it, $j$. Induct on $j$: before $o_1$, $X \notin \mathcal{X}(A)$, and each $o_j$ flips membership, so $X \in \mathcal{X}(A)$ before $o_j$ exactly when $j$ is even. The guards then fix $\mathit{op}_j$. Two valid entries $o_j \neq o_{j'}$ have statements with $j - 1 \neq j' - 1$, so they differ. An entry that replays the witness of $o_j$ after it is checked against a later count, and is invalid unless that witness also holds for the new statement. $\square$

The last step binds a witness to one change only if $\chi_A$ reads the whole statement, as a signature on it does. A rule that ignores $\mathit{op}$ or $k$ forfeits that binding, and the registry has no means of telling. The same holds for $\alpha_A$ and the components $i_0$ and $h$ of its statements.

Data can thus be withdrawn from an app at any time, for all of its past, by whoever $\chi_A$ authorizes, while the withdrawal itself is public and cannot be hidden. The committed state still holds the names of what was excluded, and only the names, since the ordering never holds content.

The presented state is a function of $\mathsf{Read}(t)$ and of values fetched by name. By Assumption O, every honest party that evaluates it at a **final** $t$, one more than $\delta$ steps old, uses the same heads, and by Theorem 1, no host can make those heads open to other states. Every honest party therefore obtains the same map, in every context. "Current" means the latest final $t$, and "historic" means any earlier one. Because the ordering keeps every prefix, a past global state is as well defined as the present one.

$\mathcal{G}_t[c]$ needs no root of its own, since a checkpoint of $\mathcal{O}$ at $t$ names $\mathsf{Read}(t)$, and thereby names $\mathcal{G}_t[c]$ for every $c$.

**Directories.** A reader finds heads through **directories**, which spare it from replaying the ordering.

**Definition 3.3 (Directory).** A **directory** is a state $D$ whose records are pairs $(e, c)$, not both $\bot$:
- $e$ is a **repo entry**, a head together with the counts that locate it in a log, or $\bot$;
- $c$ is the root $\mathsf{Com}(D')$ of a **subdirectory** $D'$, or $\bot$.

Its root is $\mathsf{Com}(D)$. Directories **nest**: following subdirectory roots down from one directory yields a tree of directories. A **path** is a sequence of keys followed down that tree, and $D(k_1, \ldots, k_j)$ is the repo entry at its end. A directory holds no empty subdirectory.

A key can carry both kinds of entry, so that a name may be at once a repo and a prefix of other repos' names.

There are two kinds of directory at $t$:
1. The **publisher directory** $D_{P,t}$ has a repo entry for each repo $\rho = (P, s)$ with $H_t(\rho) \neq \bot$:

$$
D_{P,t}(s) = \big(\mathit{pos}_t(\rho),\ H_t(\rho)\big)
$$

   Its root is $\mathsf{dir}_{P,t} = \mathsf{Com}(D_{P,t})$, and it names a Merkle DAG containing every head of $P$, which runs on to each repo's commit, its state, and its records.
2. The **app directory** $D_{A,t}$ is a hierarchy with two levels. It has a subdirectory for each publisher $P$ of which $A$ has accepted a head, $D_{A,t}(P) = (\bot,\ \mathsf{Com}(D_{A,P,t}))$, and the **accepted directory** $D_{A,P,t}$ has a repo entry for each repo $\rho = (P, s)$ with $H_t(A, \rho) \neq \bot$:

$$
D_{A,P,t}(s) = \big(n_t(A, \rho),\ \mathit{pos}_t(A, \rho),\ H_t(A, \rho)\big)
$$

   Its root is $\mathsf{dir}_{A,t} = \mathsf{Com}(D_{A,t})$, and the path of repo $(P, s)$ is $(P, s)$.

There is no directory of every publisher. A read in context $\bot$ names its publisher (Definition 3.6), and a reader that wants many publishers reads them as an app presents them, or finds them through a lens over the update log (§3.5).

**Why these trees.** A party that chooses a tree's keys can choose its shape, and with it the cost of reading the tree (§6). In each directory, the keys are chosen by a single party:
- a publisher chooses its repo names, in its own directory and in every app directory that accepts them;
- an app's acceptances choose which publishers appear in its directory, so these keys are chosen by whoever $\alpha_A$ lets accept.

A bad shape then costs only the readers of the party that chose it. A directory of every publisher would have its keys chosen by everyone who publishes, which is why there is none.

**Nesting within a publisher.** A publisher may name its repos by paths, $s = (s_1, \ldots, s_d)$, in which case its directories nest one level for each component: $D_{P,t}(s_1)$ has a subdirectory holding the names that begin with $s_1$, and so on down, and likewise $D_{A,P,t}$. Everything below a publisher is still chosen by that publisher, so the argument above continues to hold. Names are compared component by component, lexicographically, so that the repos below a prefix $(s_1, \ldots, s_j)$ form an interval of names, and a selector can name a folder of repos (Definition 3.6).
- **Cost.** Each level adds one tree to a repo's path, so finding one repo entry costs $h + 1$ nodes per level, and at most $(d + 1)(h + 1)$ under the publisher's directory, or its subdirectory of an app's, for depth $d$. **[no proof]** An interval spanning many subdirectories opens each of them, by Lemma 6.2 applied to each, but no bound for the whole interval is given here.
- **Scope.** Nesting changes how directories are committed, not the map from paths to repo entries, so realizations that prove repo entries without committing to directories, such as the storage proofs of §5, are unaffected.

We write $D_{P,t}(s)$ and $D_{A,P,t}(s)$ for the repo entries at path $s$, whether or not the publisher nests.

**Lemma 3.4 (Directories only grow) [proof].** For $t \le t'$, every repo $\rho$, and every app $A$, $\mathit{pos}_t(\rho) \le \mathit{pos}_{t'}(\rho)$ and $n_t(A, \rho) \le n_{t'}(A, \rho)$. Two authenticated entries for $\rho$ in publisher directories with the same position are equal, and so are two in $A$'s accepted directories with the same count.

*Proof.* A position changes only on a valid update of $\rho$, which increments it and appends one head to $\rho$'s history. A count changes only on a valid acceptance of $\rho$ in $A$, which increments it and appends one head to its accepted history. By Assumption O, every honest party sees the same ordering, so both histories at $t'$ extend those at $t$, and each position or count holds the same head in both. $\square$

Two readers that hold directory entries from different sources can therefore merge them by keeping, for each repo, the entry with the higher position or count. Directories hold committed and accepted heads, which exclusions do not change; exclusions change only what a reader takes from them (§3.3).

**Logs.** Whereas a directory says what is current, a log says what happened, and when. There are two kinds.
- The **update log** $\mathcal{U}_t$ has an entry for each valid update in $\mathsf{Read}_\iota(t)$, in order, each a tuple $(P, s, i, h, t_u)$, wherein $P$ and $s$ name the repo, $i$ is the position the update sets, $h$ is the new head, and $t_u$ is the clock value of the update's entry in $\mathcal{O}$. Its root is $\mathsf{log}_t = \mathsf{LCom}(\mathcal{U}_t)$, and the publisher directories are a fold of it: $D_{P,t}(s)$ is the $(i, h)$ of the last entry for $(P, s)$.
- The **app log** $\mathcal{L}_{A,t}$ has an entry for each valid acceptance, $\mathsf{exclude}$, and $\mathsf{restore}$ of $A$, in order, each with its clock value. An acceptance entry $(\mathsf{accept}, P, s, n, i, h, t_u)$ carries the count $n = n_t(A, (P, s))$ after it, and the position $i$ and head $h$ it accepts, just as an exclusion entry $(\mathit{op}, X, j, t_u)$ carries the count $j = \mathcal{C}(A, X)$ after it. A reader who follows the app log learns of exclusions as it learns of acceptances, and can rebuild $\mathcal{X}_t(A)$. Its root is $\mathsf{log}_{A,t} = \mathsf{LCom}(\mathcal{L}_{A,t})$, and $A$'s directories are a fold of it.

- The **rule log** $\mathcal{L}_{V,t}$ has an entry $(\mathsf{validate}, P, s, n, i, h, t_u)$ for each valid validation under $V$, in order, carrying the count $n = n_t(V, (P, s))$ after it. Its root is $\mathsf{log}_{V,t} = \mathsf{LCom}(\mathcal{L}_{V,t})$. It lists every repo that has passed the rule, which is how data that satisfies a rule is found (§3.5).

An app log records what the app did, not what its publishers did: an update that no acceptance names appears in $\mathcal{U}$ alone.

**Lemma 3.5 (The logs locate every head) [proof].** For each repo $\rho$ and each $1 \le i \le \mathit{pos}_t(\rho)$, $\mathcal{U}_t$ has exactly one entry for $(\rho, i)$, and the entries for $\rho$ appear in increasing order of position. For each app $A$, repo $\rho$, and $1 \le n \le n_t(A, \rho)$, $\mathcal{L}_{A,t}$ has exactly one acceptance entry for $(\rho, n)$; these appear in increasing order of $n$, and their positions increase with $n$. The same holds for the validation entries of $\rho$ in $\mathcal{L}_{V,t}$, for each rule $V$ and $1 \le n \le n_t(V, \rho)$. For each exclusion $X$ of $A$ and each $1 \le j \le \mathcal{C}_t(A, X)$, $\mathcal{L}_{A,t}$ has exactly one entry for $X$ with count $j$, in increasing order of count. Clock values do not decrease along either log.

*Proof.* Each valid update of $\rho$ sets the next position (Theorem 3), and appears once in $\mathcal{U}$, in the order of $\mathcal{O}$. Each valid acceptance of $\rho$ in $A$, or validation of $\rho$ under $V$, logs the next count, and by its guard a position beyond the last. Each valid $\mathsf{exclude}$ or $\mathsf{restore}$ of $X$ logs the next count (Proposition 3.2). Clock values do not decrease along $\mathcal{O}$ (Assumption O). $\square$

**Cost.** A valid update changes one entry in each directory on its repo's path in its publisher's directory, and appends one entry to $\mathcal{U}$; a valid acceptance changes one entry in each directory on the repo's path in its app's directory, and appends one entry to $\mathcal{L}(A)$. A full reader maintains those directories' roots by rewriting at most $2(h+1)$ nodes of each tree (Lemma 6.1), where $h$ is the tree's height. Appending to a log costs fewer than two hashes on average, and at most $\lfloor \log_2 M \rfloor$, for a log of $M$ entries (Lemma 6.3). Nothing here is computed per record.

### 3.3 Reading a slice

A reader rarely wants all of a global state; more often, they want a slice.

**Definition 3.6 (Selector, slice).** A **selector** $S$ is a finite union of boxes $\{c\} \times I_P \times I_s \times I_k$, of a context, an interval of publishers, an interval of repo names and an interval of record keys, wherein a box in context $\bot$ names one publisher, $I_P = [P, P]$. The **slice** by $S$ at $t$ is the union, over the boxes of $S$, of $\mathcal{G}_t[c]$ restricted to the box, and we write it $\mathcal{G}_t|_S$, and $\mathcal{G}^t_{t'}|_S$ likewise for the state as of $t' \le t$, read at $t$.

- TODO: Investigate sets instead of intervals

Examples:
- **one record:** $\{c\} \times [P, P] \times [s, s] \times [k, k]$;
- **one repo:** the same box, with every key;
- **one publisher's data:** $\{c\} \times [P, P]$, with every repo name and every key;
- **a whole app:** $\{A\}$, with every publisher, repo name and key;
- **across contexts:** a union of boxes in different contexts, such as one repo as two apps present it, or as its publisher committed it. $\mathsf{ReadSlice}$ reads each box against its own context's directories and exclusions, and Theorem 4 holds as for any other selector.

Selectors are built from intervals for two reasons: openings are defined on intervals (Definition 1.6), and a tree opens an interval at a cost proportional to the interval's size (Lemma 6.2). A slice by anything else, such as a record's type or the value of a field, is not a selector but a slice of a lens's view (§3.4), which is maintained so that reading it costs the same as reading an interval.

**Full and light readers.** A **full** reader holds $\mathsf{Read}(t)$ and maintains the directories itself as it replays the valid entries. A **light** reader holds only roots, and needs one thing more from the ordering service.

**Definition 3.7 (Authenticated directories and logs).** Let a light reader hold a checkpoint $d$ of $\mathcal{O}$ at a final $t$ (§1.5), and nothing else. For a context $c$ and a **box** $B = I_P \times I_s$ of publishers and repo names, with $I_P = [P, P]$ if $c = \bot$, it has three queries. Each asks an untrusted server for an answer and a proof, checks the proof against $d$, and returns the answer, or $\mathsf{fail}$ if the check fails:
1. $\mathsf{Dir}(d, c, B)$ returns the restriction of $c$'s directories to $B$,

$$
\{\, (P, s) \mapsto D_{A,P,t}(s) : P \in I_P,\ s \in I_s \,\} \ \text{ for } c = A, \qquad \{\, (P, s) \mapsto D_{P,t}(s) : s \in I_s \,\} \ \text{ for } c = \bot
$$

   which lists every repo in $B$ that has a head in $c$, with its repo entry, and no other repo.
2. $\mathsf{Log}(d, c)$ returns $\mathsf{st}(\mathcal{L}_{A,t})$ for $c = A$, or $\mathsf{st}(\mathcal{U}_t)$ for $c = \bot$, the append state of the log (Definition 1.7). From it the reader computes the log's length and its root. It checks openings of the log against that root, to read history, and appends to the state, to follow changes (§3.3).
3. $\mathsf{Excl}(d, A, Y)$, for an app $A$ and a finite set $Y$ of exclusions of $A$ that the reader names, returns the count $\mathcal{C}_t(A, X)$ of each $X \in Y$, which is $0$ for an exclusion never made. Those with odd counts are the members of $Y$ in $\mathcal{X}_t(A)$ (Proposition 3.2). A key $(P, s, k)$ can be covered only by $P$, $(P, s)$ and $(P, s, k)$, so a reader that names these for every key it reads learns every exclusion that can hide a key from it. It never needs a list of all exclusions.

The ordering service **authenticates directories and logs** if no efficient adversary answering the queries can make one of them return a value, other than $\mathsf{fail}$, that differs from the true value at $t$, except with probability $\mathbf{Adv}^{\mathsf{dir}}$. An answer that omits a repo, adds one, or gives a wrong count differs from the true value.

The answers are values of the registry $R_t$ (Definition 3.1), or commitments to them: $\mathcal{H}$ and $\mathcal{D}$ for the directories, $\mathcal{U}$ and $\mathcal{L}(A)$ for the logs, and $\mathcal{C}(A, \cdot)$ for the exclusions. What the definition requires is that a reader holding only $d$ can check them.

The cost depends on the realization, and §5 gives two. For a full reader, $\mathbf{Adv}^{\mathsf{dir}} = 0$, and the cost is a lookup in its own copy.

**Reading a slice.** A reader reads $\mathcal{G}_t|_S$ with $\mathsf{ReadSlice}$, wherein line 7 opens the state root on $I_k$, and $D'$ maps each key of the repo in $I_k$ to the name of its record.

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{ReadSlice}(d, S) \qquad (d \text{ a checkpoint at a final } t;\ S \text{ a selector}) \\
\hline
1: & Z \gets \emptyset \\
2: & \textbf{for each } \text{box } \{c\} \times I_P \times I_s \times I_k \text{ of } S\textbf{ do} \\
3: & \quad B \gets I_P \times I_s;\ E \gets \mathsf{Dir}(d, c, B);\ \textbf{if } c = \bot\textbf{ then } X \gets \emptyset\textbf{ else } Y \gets \{\, P, (P, s) : (P, s) \in \mathrm{dom}(E) \,\};\ X \gets \{\, y \in Y : \mathsf{Excl}(d, c, Y)(y) \text{ is odd} \,\} \\
4: & \quad E \gets \{\, (P, s) \mapsto E(P, s) : (P, s) \in \mathrm{dom}(E),\ P \notin X \wedge (P, s) \notin X \,\} \qquad \rhd\ \text{drop excluded repos} \\
5: & \quad \textbf{for each } (P, s) \in \mathrm{dom}(E)\textbf{ do} \qquad \rhd\ \text{in parallel} \\
6: & \quad\quad h \gets \text{the head of } E(P, s);\ (e, \mathit{parent}, \mathit{root}) \gets \mathsf{Get}(h) \\
7: & \quad\quad (D', \pi) \gets \text{an opening of } \mathit{root} \text{ on } I_k\text{, from any source};\ \textbf{require } \mathsf{Check}(\mathit{root}, I_k, D', \pi) = 1 \\
8: & \quad\quad K \gets \{\, (P, s, k) : k \in \mathrm{dom}(D') \,\};\ \textbf{for each } k \mapsto n \in D' \text{ with } c = \bot \text{ or } \mathsf{Excl}(d, c, K)((P, s, k)) \text{ even}\textbf{: } Z((c, P, s), k) \gets \mathsf{Get}(n) \\
9: & \textbf{return } Z \qquad \rhd\ \text{a map from } ((c, P, s), k) \text{ to records} \\
\hline
\end{array}
$$

The repos of a box are read in parallel, as are the fetches within a line. Line 6 fails only if no source serves the value named $h$, and since every head in a directory is the name of a commit (Definition 3.1), there is nothing else to check.

Theorem 4 shows that the result is exactly $\mathcal{G}_t|_S$, with nothing added and nothing left out. Checking an entry against $X$ takes one lookup each for its publisher, its repo, and its key, because an exclusion names exactly what it covers (Definition 3.1).

**Cost.** Let the box hold $r$ repos and $m$ records, and let $h$ bound the trees' heights. Line 3 costs what §5 states and line 4 fetches nothing, while lines 6 to 8 fetch:
- $r$ commits;
- at most $r(h+1) + m/(2^b - 1)$ tree nodes in expectation, and $r(h+1) + mh$ in the worst case (Lemma 6.2);
- $m$ records.

Nothing depends on the size of the rest of the global state. If a host serves each opening as one bundle, the read takes four round trips, for lines 3, 6, 7, and 8, whatever the slice's size, with every repo read in parallel.

**History.** The **history** of a repo is the sequence of its entries in the update log, which is the sequence of heads of Theorem 3. It is also the chain of parents its commits name, because the guard of an update requires its commit's parent to be the head (Definition 3.1). Its **accepted history** in app $A$ is the sequence of its acceptance entries in $A$'s log. A reader that wants either by position or by time takes it from the log. With $M$ the length of the log, it can read history at an authenticated $t$ in four ways:
- **One position.** To learn the head of $\rho$ at position $i$, the reader takes an index $j$ from any source, and checks an opening of $\mathsf{log}_t$ at $j$ to an entry for $(\rho, i)$. Cost: one opening, at most $2\lfloor \log_2 M \rfloor$ names (Lemma 6.3).
- **As of an earlier $t' \le t$.** $H_{t'}(\rho)$ is the head of the last entry for $\rho$ in $\mathcal{U}$ whose clock value is at most $t'$, and $H_{t'}(A, \rho)$ that of the last acceptance entry for $\rho$ in $\mathcal{L}(A)$. The reader runs $\mathsf{ReadAt}$, below. Cost: the directory entry, two openings, and no old state of the ordering.
- **A slice at an earlier $t'$.** The reader reads the directory at $t$ for the box, which lists every repo that had a head in its context at $t'$, and possibly more. It then runs $\mathsf{ReadAt}$ for each repo, and lines 6 to 8 of $\mathsf{ReadSlice}$ for the heads it returns. Cost: the directory at $t$, plus two openings per repo, plus those lines (Corollary 4.1).
- **A whole history** of $p$ positions takes $p$ openings, or $O(p \log M)$ names. Openings that share a tree share names, but no tighter bound is given here.

These reads return committed or accepted heads. A reader that presents them in an app's context applies $\mathcal{X}_t(A)$, the exclusions known now, as for any slice, while a reader that instead needs the exclusions as of $t'$, as a fraud proof does (§3.5), reads them with $\mathsf{ExclAt}$, below.

Each of these reads is an instance of one search. Call the entries of a log concerning one subject a **track**:
- the update entries of a repo $\rho$ in $\mathcal{U}$, each $(P, s, i, h, t_u)$, with index $i$ and value $h$;
- the acceptance entries of $\rho$ in $\mathcal{L}(A)$, each $(\mathsf{accept}, P, s, n, i, h, t_u)$, with index $n$ and value $h$;
- or the change entries of an exclusion $X$ in $\mathcal{L}(A)$, each $(\mathit{op}, X, j, t_u)$, with index and value $j$.

By Lemma 3.5, a track's entries carry the indices $1, \ldots, n$ in order, where $n$ is $\mathit{pos}_t(\rho)$, $n_t(A, \rho)$, or $\mathcal{C}_t(A, X)$, and their clock values do not decrease. $\mathsf{LastAt}$ finds the last entry of a track with clock value at most $t'$. The source at line 2 is asked for that entry, or for the track's first entry if there is none, and if it gives any other, line 3 or line 4 fails.

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{LastAt}(\ell, n, \sigma, t') \qquad (\ell \text{ a log root};\ n \text{ the length of track } \sigma \text{ at } t) \\
\hline
1: & \textbf{if } n = 0\textbf{ then return } \bot \\
2: & (j, l, \pi) \gets \text{from any source};\ \textbf{require } \mathsf{Verify}(\ell, j, l, \pi) = 1 \wedge l \text{ is an entry of } \sigma \text{ with index } i\text{, value } v\text{, clock value } t_u \\
3: & \textbf{if } t_u > t'\textbf{ then require } i = 1;\ \textbf{return } \bot \qquad \rhd\ \text{every entry of } \sigma \text{ is later than } t' \\
4: & \textbf{if } i < n\textbf{ then } (j', l', \pi') \gets \text{from any source};\ \textbf{require } \mathsf{Verify}(\ell, j', l', \pi') = 1 \wedge l' \text{ is an entry of } \sigma \text{ with index } i + 1 \text{ and clock value } t'_u > t' \\
5: & \textbf{return } v \\
\hline
\end{array}
$$

The two reads supply the log root and the track's length, and interpret the resulting value:
- $\mathsf{ReadAt}(d, c, \rho, t')$, for $\rho = (P, s)$, a context $c$, and a checkpoint $d$ at a final $t \ge t'$: take $\ell$ from $\mathsf{Log}(d, c)$, and $n$ from the repo entry of $\rho$ in $\mathsf{Dir}(d, c, [P, P] \times [s, s])$, its position for $c = \bot$ and its count for $c = A$, or $n = 0$ if $\rho$ is not in it. Return $\mathsf{LastAt}(\ell, n, \sigma, t')$, a head or $\bot$, for $\sigma$ the track of $\rho$ in that log.
- $\mathsf{ExclAt}(d, A, X, t')$: take $\ell$ from $\mathsf{Log}(d, A)$, and $n = \mathcal{C}_t(A, X)$ from $\mathsf{Excl}(d, A, \{X\})$. Return whether $\mathsf{LastAt}(\ell, n, X, t')$ is an odd count. $\bot$ means not excluded.

Since a key $(P, s, k)$ can be covered by only three exclusions, $P$, $(P, s)$, and $(P, s, k)$, its status as of $t'$ costs at most six openings.

**Proposition 3.8 (History reads are sound) [proof].** Given the true log root and track length at $t$, $\mathsf{LastAt}(\ell, n, \sigma, t')$ returns the value of the last entry of $\sigma$ with clock value at most $t'$, or $\bot$ if there is none, or $\mathsf{fail}$, except with probability $2\,\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$. It is **complete**: an honest source makes it return that value, not $\mathsf{fail}$. So $\mathsf{ReadAt}(d, \bot, \rho, t')$ returns $H_{t'}(\rho)$, $\mathsf{ReadAt}(d, A, \rho, t')$ returns $H_{t'}(A, \rho)$, each with $\bot$ if there was no such head at $t'$, and $\mathsf{ExclAt}(d, A, X, t')$ returns whether $X \in \mathcal{X}_{t'}(A)$, each or $\mathsf{fail}$, except with probability $2\,\mathbf{Adv}^{\mathsf{dir}} + 2\,\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$, and each is complete.

*Proof.* By position binding, each entry accepted at lines 2 and 4 is the log's true entry at its index. By Lemma 3.5, the track's entries carry the indices $1, \ldots, n$ in order, with clock values that do not decrease. If line 3 returns, the track's first entry is later than $t'$, so every entry is, and $\bot$ is right. Otherwise $t_u \le t'$, and the next entry of the track, if there is one, is later than $t'$ (line 4). So entry $i$ is the last with clock value at most $t'$. For completeness, the log holds an entry for every index from $1$ to $n$ (Lemma 3.5). The honest source opens the last entry at or before $t'$, or the first entry if there is none, and the next entry if $i < n$. Every check then passes.

For $\mathsf{ReadAt}$, $\mathsf{Log}$ and $\mathsf{Dir}$ give the true root and track length, except with $\mathbf{Adv}^{\mathsf{dir}}$ each. If $\rho$ has no head in context $c$ at $t$, it had none at $t' \le t$ (Lemma 3.4). Otherwise the last entry of its track at or before $t'$ carries the head as of $t'$, because the directories are a fold of the logs. For $\mathsf{ExclAt}$, $\mathsf{Excl}$ gives $\mathcal{C}_t(A, X)$. The last change of $X$ at or before $t'$ carries $\mathcal{C}_{t'}(A, X)$, whose parity is membership (Proposition 3.2), and if there is none, $X$ was never excluded by $t'$. $\square$

**Change.** A reader that follows a box in context $c$ keeps a cursor, consisting of the box, the append state $\mathit{st}$ of the log of $c$ (which is $O(\log M)$ names), and the box's directory entries $E$ and exclusions $X$. $E$ is kept as line 3 of $\mathsf{ReadSlice}$ returns it, before excluded repos are dropped, so that a later restore can bring a repo back. A first $\mathsf{ReadSlice}$, together with $\mathsf{Log}$, gives the cursor at $t$, and to move to $t' > t$, the reader runs $\mathsf{Follow}$:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{Follow}(d', \mathit{cur}) \qquad (\mathit{cur} = (c, B, I_k, \mathit{st}, E, X);\ d' \text{ a checkpoint at a final } t') \\
\hline
1: & \ell' \gets \mathsf{Root}(\mathsf{Log}(d', c));\ M \gets \text{the length } \mathit{st} \text{ fixes};\ (l_{M+1}, \ldots, l_{M'}) \gets \text{from any source} \\
2: & \textbf{for } j = M + 1, \ldots, M'\textbf{: } \mathit{st} \gets \mathsf{Append}(\mathit{st}, l_j) \\
3: & \textbf{require } \mathsf{Root}(\mathit{st}) = \ell' \qquad \rhd\ \text{every entry of the log since } M\text{, in order} \\
4: & \mathit{old} \gets \emptyset;\ X_0 \gets X \\
5: & \textbf{for } j = M + 1, \ldots, M'\textbf{ do} \\
6: & \quad \textbf{if } l_j \text{ is an update or acceptance entry for } (P, s) \in B\textbf{ then}\textbf{ if } (P, s) \notin \mathrm{dom}(\mathit{old})\textbf{ then } \mathit{old}(P, s) \gets E(P, s);\quad E(P, s) \gets \text{the repo entry } l_j \text{ sets} \\
7: & \quad \textbf{if } l_j = (\mathsf{exclude}, Y, \cdot, \cdot) \text{ or } (\mathsf{restore}, Y, \cdot, \cdot) \text{, with } Y \text{ in } B\textbf{ then } \text{add } Y \text{ to } X \text{, or remove it};\ \mathit{old}(P, s) \gets E(P, s) \text{ for each } (P, s) \in \mathrm{dom}(E) \setminus \mathrm{dom}(\mathit{old}) \text{ that } Y \text{ names} \\
8: & \textbf{for each } (P, s) \in \mathrm{dom}(\mathit{old})\textbf{: } \Delta(P, s) \gets \mathsf{Diff}\big(\mathit{old}(P, s),\ X_0,\ E(P, s),\ X,\ I_k\big) \\
9: & \textbf{return } \big((c, B, I_k, \mathit{st}, E, X),\ \Delta\big) \\
\hline
\end{array}
$$

$\mathsf{Diff}(e, X_0, e', X, I)$ returns the keys in $I$ whose presented records differ between the state of $e$ under $X_0$ and the state of $e'$ under $X$, where an absent entry gives the empty state, and a key covered by an exclusion is absent. $\mathsf{Diff}$ fetches the commits of the heads in $e$ and $e'$, and walks their two state trees together from the roots, skipping every pair of subtrees with equal names, every subtree outside $I$, and the whole walk if a publisher or repo exclusion hides the repo on both sides. Where the repo's exclusions changed, it also opens the old state on what became hidden, and the new state on what became shown: the key, or all of $I$ for a publisher or a repo. A reader that holds the slice already has what became hidden, and fetches nothing for it. In context $\bot$ there are no exclusions, and the log holds the updates of every publisher, of which $\mathsf{Follow}$ passes over those outside $B$.

**Cost.** Let the log of $c$ have $\Delta_c$ entries between $t$ and $t'$, and let $c'$ repos of the box have a new head or a changed exclusion. Let $x \le \Delta_c$ count the key exclusions of the box that change, and let $\Delta$ count the keys of the box whose presented record changes, including those an exclusion or restore hides or shows, plus the keys excluded on both sides whose record changes. $\Delta$ thus measures how much the presented slice changes, plus the changes that a key exclusion hides.
- lines 1 to 3 fetch $\Delta_c$ entries, and hash at most $2\Delta_c + \lfloor \log_2 M \rfloor + 1$ times (Lemma 6.3);
- lines 5 to 7 are $O(\Delta_c + c')$ lookups;
- line 8 fetches at most $2c'$ commits, $O((\Delta + c' + x)(h+1))$ nodes, and $\Delta$ records.

For line 8: in each repo, the walk fetches only nodes that differ between the two trees and whose gaps meet $I_k$. Those whose closed gap holds a changed key in $I_k$ number at most $2(h+1)$ per key (Lemma 6.1). Any other such node has a gap that meets $I_k$ and holds a changed key outside it, so it contains an end of $I_k$, and there are at most two of these per level and tree. An opening that hides or shows $m$ keys costs at most $(h+1)(m+1)$ nodes (Lemma 6.2), where the $h+1$ beyond the $m$ keys is counted by $c'$ for a publisher or a repo, and by $x$ for a key, which may hold no record. A restore therefore costs a read of the part of the slice it brings back, rather than a walk.

None of these costs depends on the size of the slice or the app, but only on how much of it changes, and on $\Delta_c$.

**Ceiling.** A light reader that follows an app fetches every entry of the app's log, at about 80 bytes an entry **[estimate]**, but these are the app's acceptances and exclusions only, not every update of its publishers. A light reader that follows one publisher in context $\bot$, and checks everything itself, fetches the whole update log, whose entries are those of every publisher. It can instead accept an indexer's sub-log of that publisher, which costs only its own entries, while still being able to hold the indexer to account (§3.5).

### 3.4 Lenses

A slice gives a reader the data as it was committed, yet most uses want something derived from it: the records of one type, an index by some field, a count, or the data without the repos a curator excludes. A lens is the general form of such a derivation.

**Overview of §3.4 and §3.5.** The definitions below are easier to follow with the whole picture in view. Consider an app for sharing recipes, whose publishers are cooks and food sites, wherein each recipe is a record with a field $\mathit{cuisine}$. A reader wants every Thai recipe in the app, from every publisher. Computing that list from the slice is easy; the questions are who computes it, and why a reader should believe them.

- **A lens is a named query.** A selector says what goes in, and a fixed function says what comes out. Our example is the **cuisine index**, whose selector is every recipe in the app, and whose function re-keys each recipe $x$ by its cuisine, as $(\mathit{cuisine}, x)$. Every Thai recipe then sits under keys beginning with `thai`, and one opening reads them all. It is the index lens on the field $\mathit{cuisine}$, among the examples below.
- **A view is the result.** It is itself a state, a key-value map with a root, and so it can be sliced, opened against its root, and used as the input of another lens.
- **A view is a fact, not an opinion.** The input is the authenticated global state, and the function is fixed and named, so everyone who computes the view at $t$ obtains the same root (Proposition 3.10), and there is nothing to vote on.
- **An indexer computes and serves views.** Recomputing a view costs reading its whole slice, so most readers let an indexer do it. The indexer follows the global state, keeps the view current, and signs a **claim**: "the view of this lens at $t$ has root $R$". A reader then reads the view like any other state, with openings against $R$, and pays only for the part it reads.

What stops an indexer from signing the wrong $R$ is that a wrong root is cheap to prove wrong, provided the lens has two properties:
- **Pointwise.** In the cuisine index, each recipe $x$ contributes at most one entry to the view, at the key $(\mathit{cuisine}, x)$, and that entry depends on that recipe alone. A wrong view is therefore wrong at some particular key $y$, and what the view should hold at $y$ depends on a single record.
- **Key-revealing.** A checker must know which input record a view key comes from. Since an indexer could invent $y$, the checker must be able to recover $x$ from $y$ alone; in the cuisine index, $x$ is part of the key.

With both properties in hand, the check proceeds as follows:
1. A **watcher**, that is, anyone who maintains the same view, compares its root with the claim, and walks the two trees down to a key $y$ where they differ (Lemma 6.1).
2. It publishes a **fraud proof**: the indexer's opening at $y$, and a point read of the one input record that $y$ comes from.
3. Anyone checks the proof by applying the lens to that one record and comparing the result with what $R$ holds at $y$, and a difference proves the claim wrong. This takes one opening of the view, one point read, and one evaluation of the lens, with no arbiter (Proposition 3.15).

The point read must give the input as it was at $t$, the claim's clock value, rather than as it is now. Because exclusions are retroactive (§3.2), excluding a recipe today removes it from every reading of the past made today. A checker using today's exclusions would therefore see an honest claim from before an exclusion as wrong, and anyone could then take its indexer's bond (§5). The point read accordingly takes heads and exclusions as of $t$ (Proposition 3.8), so that once a claim is right, it stays right.

The same property keeps views cheap to maintain. When a record changes, only its own entry in a pointwise view changes, by deleting the old entry and inserting the new one (Proposition 3.12). Filters, indexes, curation, embeddings, and per-publisher sub-logs are all pointwise. Counts and sums are not, but they can be updated in step with each change, while joins and general code are neither, and this paper gives no succinct fraud proof for them (§7).

| Term | What it is | Familiar analogue |
|---|---|---|
| selector $S$ | which data goes in | a `FROM … WHERE` clause |
| lens $L = (S, f)$ | a named, deterministic query | a view definition in SQL |
| view $V_L(t)$ | the result at $t$, a state with a root | a materialized view |
| claim | an indexer's signed "$V_L(t)$ has root $R$" | an AppView's answer, but signed and checkable |
| watcher | anyone who recomputes the view | an auditor |
| fraud proof | $(y,\ $opening of $R$ at $y,\ x,\ $point read at $x)$ | a counterexample |

An indexer here thus plays the role of an AT Protocol AppView or labeller, but with no authority: its input is public, its function is named in its claims, and a wrong answer at any one key can be proven wrong.

**Definition 3.9 (Lens).** A **lens** is a pair $L = (S, f)$ of a selector $S$ and a deterministic function $f$ from slices to states. Its **view** at $t$ is the state

$$
V_L(t) = f\big(\mathcal{G}_t|_S\big)
$$

with root $\mathsf{Com}(V_L(t))$. The function $f$ is given as code, and the lens is named $N(\texttt{lens}, L)$.

A view is a state, so everything defined for states applies to it: it has a root, it can be sliced by its own keys, it can be the input of another lens, and a publisher can commit it as a repo.

Since a selector may span contexts, so may a view: it may combine what several apps present, and what publishers committed. Each box keeps the guarantees of its context, namely what that app accepted, under which rule (Theorem 2), and what it excluded, so a view is no more trustworthy than the least trustworthy of its sources. Exclusions only add: a source's exclusions are already applied to the input, and a curation lens (below) can hide more, but never restore what a source excluded.

**Proposition 3.10 (Views are determined) [proof].** For every lens $L$ and final $t$, every honest party that computes $V_L(t)$ gets the same root, except with the probability bounded in Theorem 4.

*Proof.* By Theorem 4, every honest party obtains $\mathcal{G}_t|_S$. $f$ is deterministic, and by unique representation $\mathsf{Com}(V_L(t))$ depends only on $V_L(t)$. $\square$

A claim that "the view of $L$ at $t$ has root $r$" therefore contains its own check, since anyone can recompute the view from public data. A lens has no producer; many lenses can read the same global state, and none of them is privileged. A host that serves a view is merely a cache, and anyone who recomputes it detects a wrong one.

Computing a view from nothing costs reading its slice, plus running $f$, which is unavoidable once. What matters is the cost of keeping a view current, and that depends on the form of $f$.

**Definition 3.11 (Pointwise lens).** A lens is **pointwise** if there are functions $\tau$ and $g$ such that:
- $\tau(x, r)$ is a key of the view, and is injective in $x$: $\tau(x, r) = \tau(x', r')$ implies $x = x'$;
- $g(r)$ is a record, or $\bot$;
- the view of every slice $Z$ is

$$
f(Z) = \big\{\, \tau(x, r) \mapsto g(r) \;:\; (x \mapsto r) \in Z,\ g(r) \neq \bot \,\big\}
$$

Here $x$ ranges over the keys of the slice, which are tuples $(c, P, s, k)$.

**Proposition 3.12 (Pointwise update) [proof].** Let $L$ be pointwise, and let slices $Z$ and $Z'$ differ on a set $X$ of keys. Then $f(Z')$ is obtained from $f(Z)$ in two passes:
1. for each $x \in X$ with $Z(x)$ defined and $g(Z(x)) \neq \bot$, delete the key $\tau(x, Z(x))$;
2. for each $x \in X$ with $Z'(x)$ defined and $g(Z'(x)) \neq \bot$, insert $\tau(x, Z'(x)) \mapsto g(Z'(x))$.

*Proof.* By injectivity, every entry of the view comes from exactly one key of the slice. Entries that come from keys outside $X$ are the same in both views. An entry deleted in pass 1 and one inserted in pass 2 for a different key of $X$ have different view keys, by injectivity, so pass 1 never removes what pass 2 adds. $\square$

**Cost.** $|X|$ deletions and $|X|$ insertions, each rewriting at most $2(h+1)$ nodes of the view's tree (Lemma 6.1). Together with $\mathsf{Follow}$ (§3.3), whose $\Delta$ is at least $|X|$, a pointwise view follows its slice at a cost of $O((\Delta + c' + x)(h+1))$ node reads and writes, for $c'$ and $x$ as defined there, where a restore or an exclusion counts every key it shows or hides. This does not depend on the size of the slice or the view.

Examples, with the cost of keeping each one current:
- **Filter.** Keep the records of type $\theta$. Take $\tau(x, r) = x$, and $g(r) = r$ if $r$ has type $\theta$, otherwise $\bot$. It is pointwise.
- **Validation.** Keep the records that satisfy a deterministic predicate $\varphi$ on one record, such as conformance to a schema. Take $\tau(x, r) = x$, and $g(r) = r$ if $\varphi(r)$, otherwise $\bot$. It is pointwise and key-revealing, so a view that presents a record failing $\varphi$, or omits one that passes, has a fraud proof (Proposition 3.15). This validates at read time, as anyone may, whatever an app accepted: the lens fixes what a view holds as valid, not what an app accepts (§2), and a failing record stays in the committed state. A rule over several records, such as uniqueness of a field or a reference that must resolve, is an aggregate or a join, and has no succinct fraud proof here (§7).
- **Curation.** Drop the repos in an exclusion set $\mathcal{X}$, taking $\tau(x, r) = x$, and $g(r) = r$ unless $x$ lies in a repo in $\mathcal{X}$. For a fixed $\mathcal{X}$, it is pointwise. If $\mathcal{X}$ is itself read from the global state, adding a repo to $\mathcal{X}$ removes that repo's records from the view at a cost proportional to their number, which is exactly how much the view changes. When the input is read in an app's context, that app's exclusions (§3.2) are already applied to it, and a curation lens adds a curator's exclusions on top, so any reader or indexer can apply a different curator's lens, or none beyond the app's.
- **Index.** Re-key by a field $a$. Take $\tau(x, r) = (r.a, x)$ and $g(r) = r$. It is pointwise. Every record whose field $a$ equals $v$ is then the slice of the view on the keys that begin with $v$, which is one opening: $O(h + j)$ nodes for $j$ matches (Lemma 6.2). This is how a reader slices by the value of a field.
- **Order statistics.** The $j$ records with the largest value of $a$ are the last $j$ keys of the index on $a$, at a cost of $O(h + j)$. They need no lens of their own.
- **Aggregate.** A count, or a sum in any group, as a state with one key. It is not pointwise, but it is incremental: add $g$ of what pass 2 inserts, and subtract $g$ of what pass 1 deletes. The cost is $O(|X|)$. Minimum and maximum have no inverse, so they are read as order statistics instead.
- **Embedding.** Map each record to a vector under a fixed model $E$: $\tau(x, r) = x$ and $g(r) = E(r) \in \mathbb{R}^d$. $E$ is code plus weights, and is named in the lens. It is pointwise and key-revealing (§3.5).
  - **Cost.** Keeping the view current costs one evaluation of $E$, plus $O(h+1)$ node rewrites, per changed record.
  - **[assumption] Determinism.** Proposition 3.10 and the fraud proofs of §3.5 require $E$ to give the same output, bit for bit, for every party, which floating-point inference on different hardware does not. $E$ must therefore be a reference implementation in integer or fixed-point arithmetic, with quantized output, for example 8-bit integers. With an approximate $E$, honest indexers compute different roots, and the cross-checking of §3.5 ceases to work.
- **Join.** Records of two slices with equal values of a field $a$, keyed by $(v, x, y)$. Keep an index on $a$ for each side, and when $x$ changes on one side, open the other side's index at $v$. **[no proof]** The update costs $O(|X| (h + j))$ for $j$ matches per value, and the view is correct, though neither claim is proven here. Since the view itself can be as large as the product of the two sides, the cost is stated in terms of the output.
- **General $f$.** It must be recomputed, at $O(|\mathcal{G}_t|_S|)$ reads plus the cost of $f$. A lens on which other lenses depend should therefore be built from pointwise lenses and aggregates, so that every view on top of it stays proportional to change.

**Trusting a view.** A reader can hold a view in one of three ways:
1. **recompute it** from the slice, trusting nothing beyond Theorem 4. This costs the slice once, then the change after that, for pointwise lenses and aggregates;
2. **accept it from a host**, trusting the host, but keeping the ability to check it later by recomputing. This costs the part of the view it reads. §3.5 makes the host accountable;
3. **check a proof** that its root is $\mathsf{Com}(f(\mathcal{G}_t|_S))$, against the directories. This costs the view plus verifying the proof (§7).

A publisher that commits a view as a repo makes it authenticated data from that publisher (Theorem 2), and the claim that it is the view of $L$ can still be checked in the first way.

### 3.5 Indexers

A view has to be computed by someone, and served. An **indexer** is a party that follows the global state, maintains views, and serves them to readers. It plays the role of an AT Protocol AppView, feed generator, or labeller, with two differences:
- **It has no authority.** Its input, namely the global state and the update logs, is public and authenticated, so anyone can recompute what it serves.
- **Completeness is checkable.** What AT Protocol must trust a relay for, namely that it saw every event, is here the on-chain update log.

An indexer is a host of views, and the only way it can lie is by serving a wrong view. This section makes that lie cheap to prove.

**Lenses over logs.** A lens may also read a log, the update log or an app's log, as the map $j \mapsto \ell_j$ for $j \le M$, where $M$ is the log's length at some final $t$. The **sub-log lens** re-keys the update log by publisher:

$$
\tau(j, \ell) = (\ell.P,\ j), \qquad g(\ell) = \ell
$$

where $\ell.P$ is the update's author. The lens is pointwise (Definition 3.11), and since its view is committed with $\mathsf{Com}$, the entries of one publisher form an interval. The slice of the view on publisher $P$ is $P$'s **sub-log**: every update of $P$, in order, each with its index in the update log. The same lens over an app's log, keyed by the publisher each entry names, gives what the app accepted and excluded of $P$.

**Discovery.** The update log names every repo that has a head, and when each changed, the rule logs name what passed each rule, and the app logs what each app accepted. Together they are the input of every index of what exists: the publishers active since some $t$, the repos of a publisher, the repos that satisfy a rule, or the apps that accepted a repo. Each of these is a lens over a log, and those that are pointwise and key-revealing, as these are, have fraud proofs for an omitted entry as for a wrong one. An index of what those repos hold, such as the repos with records of some type, reads each repo the log names in context $\bot$, one publisher per box, and a key it gets wrong is found with one point read, as for any pointwise lens. A reader thereby finds repos and apps it cannot name, trusting an indexer only as far as §3.5 requires, rather than as it would trust a search engine.

**Definition 3.13 (Claim).** A **claim** is a value $c = (\iota,\ N(\texttt{lens}, L),\ t,\ R)$ signed by an indexer, for the registry $\iota$ whose ordering $t$ refers to. It asserts that $R = \mathsf{Com}(V_L(t))$. For a lens over a log, $t$ is replaced by the length $M$ of the log it reads.

**Point reads.** A **point read** of an input at a key $x$ returns the input's value at $x$, or $\bot$, together with what is needed to check it.
- **For a slice of the global state,** a point read at $x = (c, P, s, k)$ as of $t$, against a checkpoint at any final clock value from $t$ on, consists of $\mathsf{ReadAt}$ for the head in context $c$, $\mathsf{ExclAt}$ for each of the three exclusions that can cover $x$ if $c$ is an app, and lines 6 to 8 of $\mathsf{ReadSlice}$ on $[k, k]$. Since heads and exclusions are both taken as of $t$, the read returns $\mathcal{G}_t[c](P, s, k)$, by Proposition 3.8, binding of $N$, and opening binding, and an exclusion or restore made after $t$ does not change it. For an excluded key, it returns $\bot$, with the exclusion's count as the proof. At the checkpoint's own clock value, it is simply $\mathsf{ReadSlice}$ with one box, $[x, x]$ in every coordinate.
- **For a log,** it is a positional opening when $j \le M$, and $\bot$ when $j > M$, checked by position binding.

**Definition 3.14 (Key-revealing lens).** A pointwise lens is **key-revealing** if $x$ can be computed from $\tau(x, r)$.

Filter, curation, index, and sub-log lenses are all key-revealing, since their view keys either are $x$ or contain it.

A **fraud proof** against a claim $c = (\iota, N(\texttt{lens}, L), t, R)$ is a tuple $\mathit{fp} = (y, V', \pi, x, p)$, consisting of a key $y$ of the view, an opening $(V', \pi)$ of $R$ on $[y, y]$, a key $x$ of the input, and a point read $p$ of the input at $x$. When the opening holds $y$, the key $x$ is ignored and recomputed from $y$. The proof is checked by $\mathsf{CheckFraud}$:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{CheckFraud}(c, \mathit{fp}) \qquad (c = (\iota, N(\texttt{lens}, L), t, R);\ \mathit{fp} = (y, V', \pi, x, p)) \\
\hline
1: & \textbf{require } \mathsf{Check}(R, [y, y], V', \pi) = 1 \qquad \rhd\ V' \text{ is what } R \text{ holds at } y\text{: empty, or } \{y \mapsto v\} \\
2: & \textbf{if } V' \neq \emptyset\textbf{ then } x \gets \text{the key that } y \text{ reveals} \qquad \rhd\ \text{key-revealing (Definition 3.14)} \\
3: & z \gets \text{the input's value at } x \text{, from the point read } p;\ \textbf{require } p \text{ checks as of } t \qquad \rhd\ z = \bot \text{ if absent or excluded at } t \\
4: & \textbf{if } z \neq \bot \wedge g(z) \neq \bot \wedge \tau(x, z) = y\textbf{ then } U \gets \{y \mapsto g(z)\}\textbf{ else } U \gets \emptyset \qquad \rhd\ \text{what the view holds at } y \\
5: & \textbf{return } (U \neq V') \qquad \rhd\ \text{true: the claim is wrong at } y \\
\hline
\end{array}
$$

**Proposition 3.15 (Succinct fraud proofs) [proof, given opening binding].** Let $L$ be pointwise and key-revealing.
1. **Completeness:** if $R \neq \mathsf{Com}(V_L(t))$, and every head the lens reads commits to a well-formed state (§6), there is a fraud proof $\mathit{fp}$ with $\mathsf{CheckFraud}(c, \mathit{fp}) = \mathsf{true}$. It holds one opening of $R$ and one point read, and checking it evaluates $\tau$ and $g$ once.
2. **Soundness:** no efficient adversary outputs $\mathit{fp}$ with $\mathsf{CheckFraud}(c, \mathit{fp}) = \mathsf{true}$ when $R = \mathsf{Com}(V_L(t))$, except with the probability bounded by opening binding, binding of $N$ and Proposition 3.8. This holds for a claim at any $t$, however old, because the point read is taken as of $t$.

*Proof.* Let $V = V_L(t)$. By line 4, and the definition of a pointwise view, $U = V|_{[y, y]}$ whenever $z$ is the true input value at $x$ and $y = \tau(x, z)$ or $y \notin V$.

*Completeness.* The opening of $R$ at $[y, y]$ exists by correctness (Definition 1.6), and the point read at $x$ succeeds and returns the true value, by completeness of $\mathsf{ReadAt}$ and $\mathsf{ExclAt}$ (Proposition 3.8) and correctness of the state's opening. Let $V'' \neq V$ be the map $R$ commits to, and let $y$ be a key where they differ. If $y \in V$, then $y = \tau(x, r)$ for an input entry $x \mapsto r$. Take that $x$. If $V''$ holds $y$, line 2 recomputes the same $x$, because the lens is key-revealing. Either way $U = \{y \mapsto V(y)\} \neq V''|_{[y,y]} = V'$. If $y \notin V$, then $V''$ holds some $y \mapsto v$, and line 2 computes $x$ from $y$. If line 4 gave $U = \{y \mapsto v\}$, then $y$ would be in $V$ with value $v$. So $U \neq V'$.

*Soundness.* Let $R = \mathsf{Com}(V)$. By opening binding, $V' = V|_{[y, y]}$. By Proposition 3.8, binding of $N$ and opening binding, $z$ is the true value at $x$ as of $t$. If $y \in V$, then $x$ is the key $y$ reveals, by line 2, so $y = \tau(x, z)$ and $U = V|_{[y,y]}$. If $y \notin V$, then $U$ is empty, because otherwise $y$ would be in $V$. Either way $U = V'$, and $\mathsf{CheckFraud}$ returns $\mathsf{false}$. $\square$

To find $y$, someone must compute $V$, namely a **watcher** (below), and every other reader then pays two openings to check the proof.

Indexing networks such as The Graph [TG] ask an indexer to commit to the sequence of writes it made, its "proof of indexing". A mismatch between two indexers then shows only that they disagree, and a dispute goes to an arbitrator appointed by governance. A claim here, by contrast, commits to the view itself, so that a mismatch can be walked down to the key where the two disagree (Lemma 6.1), and $\mathsf{CheckFraud}$ decides which one is wrong, with no arbiter.

**Cost of a fraud proof:**
- **for a lens over a log:** one map opening, $O(h+1)$ nodes (Lemma 6.2), plus one log opening, at most $2\lfloor \log_2 M \rfloor$ names (Lemma 6.3);
- **for a lens over a slice:** the map opening, plus a point read as of $t$: two log openings for the head, at most six for the exclusions, and one opening of the state (Proposition 3.8, Lemma 6.2).

**Indexers and exclusions.** An indexer that serves a view over a slice in the context of app $A$ applies $\mathcal{X}_t(A)$, because its input is the presented state, and such a view that still holds an excluded entry is wrong, as Proposition 3.15 proves: the point read returns $\bot$. Exclusions apply to record content, whereas a lens over a log reads committed metadata (names, positions, heads, and clock values), never record content. Names are still strings that publishers choose, and an exclusion withdraws a record from presentation without erasing the names already committed, which the log and the directories keep. Like the directories, the log holds committed heads, which exclusions do not change (§3.2). A sub-log view therefore keeps the entries of every repo, whatever any app has excluded, and is right to do so. An indexer may also block more than the app does, for its own reasons, as a curation lens of its own named in its claims, which requires nothing from the protocol.

**Equivocation.** If an indexer signs two different roots for the same lens and the same $t$, the pair is itself evidence: by Proposition 3.10, at most one of the roots is right, and Proposition 3.15 gives a fraud proof against the other.

**Following one publisher.** A reader that follows $P$ in context $\bot$ does three things:
1. it takes a claim for the sub-log lens at length $M'$;
2. it proves the length $M$ of the update log from the chain (§5), to learn how far behind the claim is;
3. it reads the slice of $R$ on the keys $(P, j)$ with $j$ beyond its cursor.

This costs one slot proof, one signature, and $O(h + \Delta_P)$ nodes for $\Delta_P$ new entries (Lemma 6.2), independent of every other publisher. The reader can also check any entry against the update log, at $O(\log M)$ each, which catches forged entries but not omitted ones; omissions are what fraud proofs are for.

**Watchers.** A **watcher** maintains a view itself, and compares its root with the claims it sees. A fraud proof is useful only if a watcher finds the error and the reader learns of it, which requires four things. **[no proof]** They are argued here, not proven to be sufficient.

1. **Someone recomputes.** At least one honest watcher maintains the view, at the same cost as the indexer, $O(|X|(h+1))$ per change for a pointwise lens (Proposition 3.12). Three kinds of party are natural watchers:
   - **Other indexers** of the same lens, who already maintain it at no extra cost.
   - **A publisher, for its own sub-log.** Because it knows the indices of its own updates from the ordering, it can check that none was omitted with one opening of $R$ per update, $O(\Delta_P (h+1))$ in all, without maintaining the view.
   - **Anyone paid by a bond** (§5).
2. **A watcher sees the root.** A dishonest indexer can sign a wrong root and serve it to one reader only, in which case no watcher sees that root, and no fraud proof is ever found. There are two defences:
   - **Cross-checking.** The reader asks a second indexer, independent of the first, for its root for the same lens and $t$. Honest indexers agree exactly (Proposition 3.10), so a mismatch shows that one of them is wrong. Walking the two trees together (Lemma 6.1) finds each key where they differ in $O(h+1)$ nodes, and Proposition 3.15 then says which indexer is wrong. This costs one more root per read, and fails only if every indexer asked is wrong in the same way, which in practice means collusion.
   - **Published claims.** The reader accepts only roots that are published where watchers look, whether posted to the ordering service or to a public feed of claims. Targeting a single reader then becomes impossible, at the cost of publishing each claim.
3. **The reader can complete the proof itself.** A fraud proof needs an opening of $R$, and an indexer can refuse to serve its nodes to watchers, without which a watcher cannot find $y$. The reader, however, already holds the nodes it read. It compares the slice it read with the same slice of an honest watcher's view, at the cost of reading that slice a second time, and any difference gives it $y$, with the opening of $R$ already in hand. The other half of the proof, the point read, comes from public authenticated data. Withholding nodes can thus stop a watcher from proving fraud to everyone about parts nobody has read, but it cannot hide fraud from a reader about what that reader read.
4. **There is no challenge window.** Nothing settles on a claim, and a reader acts on a view when it chooses. A later fraud proof gives it a correction, and, with a bond (§5), compensation. A reader about to do something it cannot undo should cross-check first. How long to wait, if at all, is each reader's choice rather than a parameter of the protocol.

**Trusting an indexer.** A reader can trust an indexer at one of five levels, from cheapest to strongest:
1. **Trust it.** This is the AT Protocol model.
2. **Hold it to account.** Wrong claims are cheap to prove (Proposition 3.15), which requires one honest watcher that sees the reader's root, whether because the root is published or because the reader cross-checks it.
3. **Cross-check $k$ independent indexers.** The view is correct unless all $k$ are wrong in the same way, and no watcher is needed.
4. **Check a proof of the view** (§3.4).
5. **Recompute the view** from the input.

An indexer can still lag, which the reader detects by comparing $M'$ with $M$, and it can refuse to serve, in which case the reader moves to another indexer or recomputes. Indexers are not privileged: any number can serve the same lens from the same public input, and any two of them that agree have the same root.

**Shape.** The keys of a sub-log view are $(P, j)$, where the ordering assigns $j$. A publisher picks its own address, but not the indices its updates land at. **[no proof]** A publisher could choose its address, or time its updates to land at chosen indices, and whether either helps an attack on shape is not analysed.

**Search over a bundle.** The simplest search index is the embedding view itself. A host serves it as a **bundle**: the view's entries, split into shards by key interval, each shard an opening of the view's root on its interval (Definition 1.6), so that a reader checks each shard against a claim's root as it arrives. The reader fetches every shard, scores each vector against its query, and keeps the $j$ best. The result is exact, and, unlike that of the tree below, complete: an opening binds every key of its interval, so a host can neither forge an entry nor omit one (Definition 1.6), and the claim's root is itself held to account (Proposition 3.15). The query never leaves the reader, and every reader of the view fetches the same shards, so the hosts learn which views a reader searched, but nothing of what it searched for. **[estimate]** A view of $10^5$ records with 256-dimensional 8-bit vectors is about 26 MB, which a reader fetches once, and then follows by change (Proposition 3.12). A bundle suits a view up to the size a reader is willing to hold. Past that, the reader fetches part of the view, through a tree.

**Search indexes.** For a view too large to fetch whole, finding the records whose embeddings best match a query should not require fetching every vector. The structure below makes this possible, while keeping it checkable.

For a query $q \in \mathbb{R}^d$ with $\Vert q \Vert \le 1$, the score of a vector $v$ is $\langle q, v \rangle$.

**Definition 3.16 (Bounded tree).** A **bounded tree** over an embedding view $V$ is a Merkle DAG with two kinds of node:
- each **leaf** holds an entry $(x, v)$ of $V$;
- each **internal node** holds a centre $\mu \in \mathbb{R}^d$, a radius $\varepsilon \ge 0$, and the names of its children.

A node is **sound** if every leaf $v$ below it has $\Vert v - \mu \Vert \le \varepsilon$. The tree is sound if every node is.

The **bound** of a node is $\beta(n) = \langle q, \mu \rangle + \varepsilon$ for an internal node, and $\beta(n) = \langle q, v \rangle$ for a leaf $(x, v)$. A reader searches with $\mathsf{Search}$:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{Search}(\alpha, q, j) \qquad (\alpha \text{ the root of a bounded tree};\ \Vert q \Vert \le 1) \\
\hline
1: & Q \gets \{\mathsf{Get}(\alpha)\};\ T \gets \emptyset \qquad \rhd\ Q\text{: nodes to expand};\ T\text{: the best } j \text{ leaves so far} \\
2: & \textbf{while } Q \neq \emptyset\textbf{ do} \\
3: & \quad n \gets \text{the node of } Q \text{ with the highest bound } \beta(n);\ \text{remove } n \text{ from } Q \\
4: & \quad \textbf{if } |T| = j \wedge \beta(n) < \min_{(x, v) \in T} \langle q, v \rangle\textbf{ then return } T \\
5: & \quad \textbf{if } n = (x, v) \text{ is a leaf}\textbf{ then } \text{add } n \text{ to } T\text{, keeping the } j \text{ best} \\
6: & \quad \textbf{else for each } \text{child name } c \text{ of } n\textbf{: } \text{add } \mathsf{Get}(c) \text{ to } Q \\
7: & \textbf{return } T \\
\hline
\end{array}
$$

**Lemma 3.17 (Sound bounds prune exactly) [proof].** If a node with centre $\mu$ and radius $\varepsilon$ is sound, then every leaf $v$ below it has $\langle q, v \rangle \le \langle q, \mu \rangle + \varepsilon$. Consequently, on a sound tree, $\mathsf{Search}(\alpha, q, j)$ returns $j$ leaves of highest score, or every leaf if there are fewer.

*Proof.* $\langle q, v \rangle = \langle q, \mu \rangle + \langle q, v - \mu \rangle \le \langle q, \mu \rangle + \Vert q \Vert\, \Vert v - \mu \Vert \le \langle q, \mu \rangle + \varepsilon$, by Cauchy–Schwarz, $\Vert q \Vert \le 1$, and soundness. Every leaf not yet reached lies below a node in $Q$, so its score is at most that node's bound, which is at most $\beta(n)$ for the node $n$ of line 3. When line 4 returns, that is below every score in $T$. $\square$

Quantization, and any other approximation, is absorbed into $\varepsilon$ and needs no separate argument.

**Not a view.** A bounded tree need not be a function of $V$: any centres and radii are allowed, and two honest indexers may build different trees. What makes a tree checkable is that soundness is a local property:
- **A false bound** has a fraud proof [proof], consisting of a node, a path of child names from it to a leaf $(x, v)$, and the fact that $\Vert v - \mu \Vert > \varepsilon$. Names fix every node on the path, so the proof costs one node per level and one distance.
- **A forged leaf**, whose $(x, v)$ is not an entry of $V$, has a fraud proof [proof], consisting of the leaf, the path to it, and a point read of the embedding view at $x$ (Proposition 3.15).
- **[open] An omitted entry,** that is, an entry of $V$ with no leaf, has no succinct fraud proof given here. The tree is ordered by geometry rather than by key, so one opening cannot show that $x$ is absent. A count of leaves in each node, checked against the size of $V$, would turn an omission into a duplicate or a forged leaf somewhere, but the size of $V$ is an aggregate, and locating the fault is not shown to be succinct.

A sound tree therefore gives no false negatives among its leaves, and none at all once omissions can be ruled out.

**Cost of a bounded tree:**
- **Inserting a leaf:** descend from the root, enlarging the radius of each node on the way down, for $O(\mathit{depth})$ node rewrites, each $O(d)$.
- **Deleting a leaf** keeps every node sound, because soundness quantifies only over the leaves present. Bounds grow looser as leaves are deleted, and an occasional rebuild, at $O(|V|)$, tightens them again.
- **Shape.** The indexer chooses the tree's shape. A deep or loose tree is slow to search, but it is not fraud, and readers choose between indexers by the results they get.
- **[no proof] Search.** How many nodes a search visits depends on how tight the bounds are near the query, and may be every node. No bound on the expected number is given here.

**Searching on the reader's side.** An indexer can serve search in one of three ways:
- **Serving the bundle,** in which case the reader ranks every record itself, and the hosts learn nothing about the query.
- **Serving the tree,** in which case the reader runs the search of Lemma 3.17 itself, and the query never leaves its device. Nodes are named by $N$, so any host can serve them, not only the indexer.
- **Answering queries,** in which case the indexer sees every query, and learns what each reader searches for.

Serving the bundle is the default for a view small enough to fetch whole, serving the tree for a larger one, and answering queries is a downgrade a reader chooses. With the tree served, the hosts see which nodes a reader fetches, which reveals roughly where the query lies, near the centres of the nodes it expanded. **[open]** A reader can blur this by always fetching a fixed number of nodes per query, and by spreading its fetches across hosts, but how much that hides is not analysed here.

**Other lenses.** Aggregates, joins, and general lenses are either not pointwise or not key-revealing, and a fraud proof against them needs the part of the input they read, which may be all of it. For these lenses, our position is the same as that of [TG]. **[open]** Succinct fraud proofs for them, for example by bisecting the computation, are not given here.

### 3.6 Costs

$h$ is a tree's height and $2^b$ its expected fanout, and every node has at most $B_{\max}$ entries (§6). For keys whose names are random, $h \approx \log_{2^b} n$ for $n$ entries. A party that chooses keys can raise $h$ to $\ell$ by trying about $2^{b\ell}$ candidates, though $h \le 2\lambda / b$ always.

| Operation | Cost | Status |
| --- | --- | --- |
| Maintain directories, per valid update or acceptance | $\le 2(h+1)$ node rewrites per tree | Lemma 6.1 [proof] |
| Read a slice of $r$ repos and $m$ records | directory (§5), plus $r$ commits, $r(h+1) + m/(2^b-1)$ nodes in expectation, $m$ records; 4 round trips | Lemma 6.2 [proof; expectation for random names] |
| Append to a log of $M$ entries, per valid update, acceptance, exclusion, or restore | fewer than 2 hashes on average, at most $\lfloor \log_2 M \rfloor$ | Lemma 6.3 [proof] |
| Head of a repo at a position, or as of an earlier $t'$; status of an exclusion as of $t'$ | 1 or 2 openings, each at most $2\lfloor \log_2 M \rfloor$ names; no old state | Proposition 3.8, Lemma 6.3 [proof] |
| Read a slice as of an earlier $t'$ | a current read, plus 2 openings per repo | Corollary 4.1 [proof] |
| Follow a slice from $t$ to $t'$, with $\Delta_c$ entries in its context's log, $c'$ repos changed, $x$ key exclusions changed, and $\Delta$ keys changed, counting those an exclusion or restore hides or shows | $\Delta_c$ log entries and $O(\Delta_c + \log M)$ hashes, plus $2c'$ commits, $O((\Delta + c' + x)(h+1))$ nodes and $\Delta$ records | Definition 1.7, Lemmas 6.1, 6.2 and 6.3 [proof] |
| Follow a pointwise view | following its slice, plus $O(\lvert X \rvert (h+1))$ node rewrites, $\lvert X \rvert \le \Delta$ | Proposition 3.12, Lemma 6.1 [proof] |
| Read by field value, through an index | $O(h + j)$ nodes for $j$ matches | Lemma 6.2 [proof] |
| Follow an aggregate in a group | $O(\lvert X \rvert)$ | [proof: one line, above] |
| Follow a join | $O(\lvert X \rvert (h + j))$ | **[no proof]** |
| Follow one publisher through an indexer | 1 slot proof, 1 signature, $O(h + \Delta_P)$ nodes | Lemma 6.2 [proof]; trust as in §3.5 |
| Follow an embedding view | one evaluation of $E$, plus $O(h+1)$ node rewrites, per changed record | Definition 3.11, Lemma 6.1 [proof]; determinism [assumption] |
| Insert into a bounded tree, or delete from it | $O(\mathit{depth} \cdot d)$ to insert; deleting needs no change of bounds | Definition 3.16 [proof] |
| Search a bounded tree | between $O(\mathit{depth})$ nodes and every node, depending on the bounds | Lemma 3.17 [proof of exactness]; **[no proof]** of expected cost |
| Check a fraud proof against a bounded tree | one node per level, plus one distance or one point read | §3.5 [proof] |
| Check a fraud proof against a pointwise, key-revealing lens | 1 map opening plus 1 point read: over a log, $O(h + \log M)$ names | Proposition 3.15 [proof, given opening binding] |
| Any other lens | the whole slice, plus the cost of $f$ | — |

## 4. Security of data and history

**Theorem 1 (Binding) [proof].** No efficient adversary controlling every host can make an honest reader accept, for head $h$, any state other than the one committed by $h$, except with probability $\mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{bind}}_{\mathsf{Com}}$.

*Proof.* Every node is accepted only if its name matches, so substituting a node finds a collision in $N$. The reader recomputes $\mathsf{root}$ over the records it received, so two different states accepted for one root break binding of $\mathsf{Com}$. $\square$

**Theorem 2 (Authenticity and acceptance) [proof].** Under Assumption O, except with negligible probability:
1. every head in the history of repo $(P, s)$ was set by an entry authored by $P$;
2. every head in the accepted history of $(P, s)$ in app $A$ is the head of $(P, s)$ at the position it was accepted at, and was accepted with a witness under $\alpha_A$, as evaluated when the acceptance was applied, for a statement naming that position and head and the position accepted before it;
3. every head in the validated history of $(P, s)$ under rule $V$ is the head of $(P, s)$ at its position, and has a witness under $\nu_V$ for a statement naming that position and head and the position validated before it.

*Proof.* Heads change only through valid updates. An update moves the head of $(P, s)$ only when its author is $P$ (line 2 of $\mathsf{Apply}$), and an accepted entry with author $P$ that $P$ did not make contradicts authorship. Accepted heads change only through valid acceptances, whether submitted alone or carried by an update. The guard of an acceptance requires an entry $(P, s, i, h, \cdot)$ of $\mathcal{U}$, which by Lemma 3.5 is the only entry for position $i$, so $h$ is the head at position $i$. It also requires a witness under $\alpha_A$ for the statement $(\iota, A, \mathsf{accept}, (P, s), i_0, i, h, t_x)$, with $i_0$ the position accepted before. Validations are alike, with $\nu_V$ in place of $\alpha_A$ (lines 11 and 12). $\square$

What a validation shows about the content of $h$ is exactly what its evidence shows (§2), and what an acceptance shows is whatever $\alpha_A$ demands, typically validations under named rules. A witness for one statement is useless for any other acceptance, since the next acceptance of the same repo in the same app names a larger $i_0$, provided that $\alpha_A$ reads the whole statement (§3.2).

**Theorem 3 (Linear history) [proof].** Under Assumption O, for every repo, the valid updates form one sequence. The $i$-th sets the head at position $i$ to the name of a commit whose parent is the head at position $i - 1$. No head occurs twice, except with probability $\mathbf{Adv}^{\mathsf{bind}}_N$. For every app and every rule, the valid acceptances, and the valid validations, of the repo each form one sequence whose positions increase, so its accepted and validated histories are subsequences of its history.

*Proof.* The ordering is total. By its guard (Definition 3.1), an update is valid only if its commit's parent is the current head at its place in the order, and line 3 sets the head to that commit's name. Induct on $\mathcal{O}$. Write $h_0 = \bot$, and suppose $h_i = h_j$ with $i > j \ge 1$, for the least such $j$. The commits named $h_i$ and $h_j$ are $(e_i, h_{i-1}, \mathit{root}_i)$ and $(e_j, h_{j-1}, \mathit{root}_j)$. If they differ, they are a collision of $N$. Otherwise $h_{i-1} = h_{j-1}$. If $j = 1$, that says $h_{i-1} = \bot$, but every head at a position of at least $1$ is a name. Otherwise it contradicts the choice of $j$. The acceptances of a repo in one app, and its validations under one rule, are ordered by $\mathcal{O}$, and by the guards on lines 4 and 11 each takes a position beyond the last, which by Lemma 3.5 names a head of the history. $\square$

Theorems 2 and 3 concern committed and accepted heads, which exclusions do not change; exclusions change only what is presented (Proposition 3.2). Because the registry computes each head from its commit's fields, the order of Theorem 3 and the chain of parents that the commits name are one and the same history.

**Theorem 4 (Slice soundness) [proof, given opening binding].** Let $t$ be final, and $S$ a selector with $q$ boxes, over which $\mathsf{ReadSlice}$ reads $r$ repos. No efficient adversary controlling every host and server can make $\mathsf{ReadSlice}(d, S)$ return any map other than $\mathcal{G}_t|_S$, except with probability at most $(2q + r)\,\mathbf{Adv}^{\mathsf{dir}} + \mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$.

*Proof.* Fix a box $\{c\} \times I_P \times I_s \times I_k$. If $c = \bot$, there are no exclusions to read, and the steps below apply without them.
1. **Lines 3 and 4.** Line 3 yields the true restriction of $c$'s directories, and the true counts of the publisher and repo exclusions of every repo in it, except with $\mathbf{Adv}^{\mathsf{dir}}$ for each of its two queries. A publisher or repo exclusion that hides a repo of the box is one of these, and line 4 is deterministic. So $E$ holds exactly the presented repos of the box, with their true heads.
2. **Lines 6 and 7.** $\mathsf{Get}$ accepts the commit only if it matches its name $h$, so it is the commit whose name the registry computed (Definition 3.1). By correctness, $M_h|_{I_k}$ has an accepting opening against the commit's state root. If the reader accepts any other map, then two different maps have accepted openings for the same root and interval, which breaks opening binding.
3. **Line 8.** Its query yields the true counts of the key exclusions of the keys read, except with $\mathbf{Adv}^{\mathsf{dir}}$ for each repo. Those are the only key exclusions that can cover them. Dropping excluded keys is then deterministic, and $\mathsf{Get}$ accepts each record only if it matches its name.

Apart from the $2q + r$ directory failures, any substitution is a collision in $N$, or two accepted openings. $\square$

**Corollary 4.1 (Historic slices) [proof, given opening binding].** Let $t$ be final, $t' \le t$, and $S$ a selector with $q$ boxes and $r$ repos. For each box, let the reader run lines 3 and 4 of $\mathsf{ReadSlice}$ and $\mathsf{Log}(d, c)$; for each repo left, $\mathsf{LastAt}$ with that log root and the length of the repo's track; and for each head $h \neq \bot$ returned, lines 6 to 8 of $\mathsf{ReadSlice}$. No efficient adversary controlling every host and server can make the result differ from $\mathcal{G}^t_{t'}|_S$, except with probability at most $(3q + r)\,\mathbf{Adv}^{\mathsf{dir}} + 2r\,\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}} + \mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$.

*Proof.* Step 1 of Theorem 4 applies to lines 3 and 4, and $\mathsf{Log}$ adds one more query per box. Line 8 adds one per head read, at most $r$. The counts are those at $t$, as $\mathcal{G}^t_{t'}$ requires. By Lemma 3.4, every repo with a head at $t'$ has one at $t$, so the directory at $t$ lists every repo of the box on which $\mathcal{G}^t_{t'}$ can be defined. For each, Proposition 3.8 shows that $\mathsf{LastAt}$ gives the head of $\rho$ in the box's context as of $t'$, or $\bot$ if there is none, except with $2\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$. Steps 2 and 3 of Theorem 4 then apply to that head. $\square$

Theorem 4 holds for any $\mathsf{Com}$ with opening binding, and for the tree of §6, opening binding is Lemma 6.2.

Theorem 4 gives completeness as well as inclusion. A host can refuse to serve part of a slice, in which case the reader knows the slice is incomplete, but it cannot make the reader accept a partial slice as the whole. This is precisely what a light reader loses without authenticated directories: it can still prove the head of a repo it can name, but the repos it cannot name are exactly those a host can withhold.

# Part II — Instantiation

## 5. The ordering service as a blockchain

A public blockchain is an ordering service: its blocks are the sequence, its block timestamps the logical clock, and $\mathsf{Verify}$ its validity rule, whether proof of work or the signatures of its validators. Assumption O then holds under the chain's own consensus assumptions:
- agreement, with $\delta$ the chain's finality delay for the kind of reader in question (below);
- authorship, from its signature scheme;
- a clock, from block timestamps, which consensus keeps non-decreasing and within a bounded skew of real time. Epochs are then measured in time, and do not move when block times change. Skew shifts the window of Definition 3.1 by at most its bound, and can only cause an update to fail, which costs liveness. The bound is assumed, not derived.

**Finality.** What $\delta$ is depends on how a reader checks headers. A full node that derives the chain itself sees an entry as final once the chain's own finality covers it, which on a rollup means once its batch is final on the base chain, typically within an hour. A light reader that checks a rollup's state roots without trusting its proposer must instead wait until they are settled: about seven days, the challenge window, on an optimistic rollup, and the time to prove one on a ZK rollup. Its latest final header is then old state, and storage proofs against it require a node that keeps archive state, which most nodes do not. A light reader on an optimistic rollup therefore either uses such a node, or trusts the proposer's latest root and takes the shorter $\delta$, which adds that trust to $\mathbf{Adv}^{\mathsf{dir}}$.

The registry (Definition 3.1) is run by the chain, as a program whose transition is $\mathsf{Apply}$. It keeps $\mathcal{R}$, $\mathcal{A}$, $\mathcal{H}$, $\mathcal{V}$, $\mathcal{D}$, $\mathcal{X}$, and $\mathcal{C}$ in its storage, and only commitments for $\mathcal{U}$ and $\mathcal{L}$ (below). It rejects an invalid entry rather than recording it, which comes to the same thing, since $\mathsf{Apply}$ leaves the state unchanged on one. It may be split across contracts, for example a data registry for $\mathcal{H}$ and $\mathcal{U}$, and an app registry for the rest, but the program decides nothing that $\mathsf{Apply}$ does not, and anyone holding the chain could compute the same state. Its identifier $\iota$ is the chain's identifier together with the program's address. On an EVM chain, an entry is a transaction, whose destination $d$ is the pair of its chain identifier and its `to` address, and whose operation $\mathit{op}$ is its calldata. The transaction signature covers all three, the chain identifier under EIP-155, so it is a signature on $(d, \mathit{op})$, as Assumption O.2 requires. A statement is signed as EIP-712 typed data, with $\iota$ as the `chainId` and `verifyingContract` of its domain. For an update, the program computes $h' = N(e, \mathit{parent}, \mathit{root})$ itself, as the name of the commit in its canonical encoding (§6), so that every head it stores names a commit. **[estimate]** With a fixed encoding template and the chain's SHA-256 precompile, this costs a few hundred gas. It rejects a late update with an error of its own, so that a publisher's tooling can commit again under the current epoch and resubmit.

**Acceptances.** For an acceptance, the program checks that $h$ is the head at position $i$ of $\rho$: directly against $\mathcal{H}(\rho)$ when $i$ is the current position, and otherwise by a positional opening of $\mathcal{U}$ (Definition 1.7), carried in the entry and checked against the update log's peaks (below), at most $2\lfloor \log_2 M \rfloor$ hashes for a log of $M$ entries. It checks the witness under $\alpha_A$ as it checks one under $\chi_A$, so a rule that requires a proof names a verifier program that the check calls, and a rule that requires a validator's signature reads the validator's key from a program that $o_A$ controls. An update carries the acceptances it bundles in the same transaction. Whoever submits an acceptance pays for it: the app, when it pulls data that its publisher committed at no cost to the app, or the publisher, when it bundles the acceptance in its update.

**Validations.** The program checks a validation's head as it checks an acceptance's, and then its witness, by the kind of evidence the rule takes (§2). A check by the registry receives the records it reads, with their openings, in the entry, and its cost grows with what the rule reads, so it suits rules over a few records. A proof is checked by a verifier program that the rule names, **[estimate]** about 250k gas for a pairing-based proof, whatever the size of the state. An attestation is a signature, a few thousand gas, from a key that a program lists once the attestation of the hardware that holds it has been checked, on the chain or off it. A rule whose verifier accepts a batch lets one proof or attestation validate many repos, and a validation, once paid for, serves every app that requires its rule.

**Directories.** A chain can authenticate directories (Definition 3.7) in two ways. **[assumption]** Both rest on the chain's light-client protocol, wherein a light reader verifies block headers and proves values of the program's state against a header's state commitment. That protocol is taken to satisfy Assumption O for a light reader, and is not specified here (§7).

1. **By storage proofs.** The chain's commitment to its state proves any slot the reader names, but cannot list the slots that belong to a publisher or an app. The program therefore keeps three lists, each appended on first write, alongside each repo's head and position and each accepted entry:
   - for each publisher, its repos;
   - for each app, the publishers of which it has accepted a head;
   - for each publisher in each app, the repos of it that the app has accepted.

   A light reader proves, against the header at $t$, for a box in context $\bot$, the publisher's list of repos, filtered by $I_s$, and the head and position of each repo that remains. For a box in context $A$, it proves:
   - the app's list of publishers, filtered by $I_P$;
   - for each of those publishers, the app's list of its repos, filtered by $I_s$;
   - the accepted entry of each repo that remains.

   **Cost.** A constant number of slot proofs per repo of the publishers in $I_P$, one per publisher, and none per record. **[estimate]** Each slot proof is a path in the chain's state trie of a few kilobytes, and proofs against one header share their upper nodes. An update of an existing repo writes four slots that already exist (its head, its position, one peak of the update log, and the log's length, below), for about 20k gas. The first update of a repo also creates its head and position slots, an element of its publisher's repo list (more than one if the name is long), and that list's length. A new slot costs about 22k gas, so a first write costs on the order of 100k. An acceptance of a repo the app accepted before writes its accepted entry, one peak of the app log, and the log's length, for about 20k gas, plus the cost of checking its witness, and of a log opening when it accepts a position other than the latest; the first acceptance of a repo also adds to the app's lists, on the order of 100k. An $\mathsf{exclude}$ or $\mathsf{restore}$ writes its counter, one peak, and the log's length.

   **Ceiling.** The lists are in the order in which repos were created, not in key order, so a reader that wants a narrow $I_s$ within a publisher that has many repos pays for all of that publisher's repos.
2. **By checkpoints.** A party posts $\mathsf{dir}_{A,t}$ to the chain, with a proof that it is the fold of $A$'s valid acceptances up to $t$. A light reader then proves one slot and opens the directory trees, which for a box with $r$ repos over $p$ publishers costs $O((p + r)(h+1))$ nodes (Lemma 6.2), whatever the size of the app. By Lemma 6.1, the fold changes $O(\Delta (h+1))$ nodes per checkpoint for $\Delta$ updates. The proof system and its cost are out of scope (§7).

**Exclusions.** The program checks the witness of each $\mathsf{exclude}$ and $\mathsf{restore}$ against $\chi_A$, for the statement with $\iota$, the current $\mathcal{C}(A, X)$, and the deadline. If $\chi_A$ refers to a list of moderators, a program that $o_A$ controls keeps it, and the check reads it as it stands when the entry is applied (§2). The program keeps one slot for each exclusion ever made, whether of a publisher, a repo, or a key: the counter $\mathcal{C}(A, X)$, which is kept after a restore. Since $X \in \mathcal{X}(A)$ exactly when $\mathcal{C}(A, X)$ is odd (Proposition 3.2), the counter is also the flag, and storage grows by one slot per distinct exclusion ever made.

The program names repos and keys by hash. An exclusion appears as $P$, $(P, N(s))$, or $(P, N(s), N(k))$ in its slots, its operations, and its log entries, never as $s$ or $k$ in clear, so taking down a record does not write its key to the chain. Hashing, however, hides nothing that can be guessed: anyone who guesses a key, such as a person's name or an email address, can compute its hash. The repo's name is already in the repo list and the update log (above), and an exclusion does not erase it.

A light reader proves the counters of the publishers and repos in its box, and of each key it reads, alongside their directory entries, where a slot never written proves a count of $0$. This realizes $\mathsf{Excl}$ as Definition 3.7 states it, in that the reader names the exclusions and proves one slot for each, at a cost of a constant number of slots per repo plus one per key read, which is light for point reads and heavy for large slices. The reader matches exclusion entries in the log by hashing the names it reads. **[no proof]** The cost of checking a witness under $\chi_A$ on-chain depends on the rule, and is not given here.

Storage proofs need no prover, and suit small apps and reads of one publisher, while checkpoints suit apps whose readers want slices across many publishers.

**Logs.** For the update log, and for each app's and each rule's log, the program keeps the length $M$ of the log, and the peaks of a Merkle mountain range over it (§6), in one slot per peak height. Each valid update appends the leaf for $(P, s, i, h', t_u)$ to the update log, where $t_u$ is the block timestamp, and each valid acceptance, $\mathsf{exclude}$, and $\mathsf{restore}$ appends its own entry to its app's log in the same way, as each valid validation does to its rule's log. On chain, $\mathsf{LCom}$ uses keccak-256 in place of $N$, over $\texttt{abi.encode}$ of a fixed schema for each kind of entry, and keeps the tags $\texttt{leaf}$, $\texttt{node}$, and $\texttt{mmr}$. Since Definition 1.7 needs only binding, Lemma 6.3 holds with keccak-256 for $N$. $\texttt{abi.encodePacked}$ is not injective, and must not be used.
- **Cost.** Two storage writes per log entry, one peak and $M$, plus fewer than one storage read and two hashes on average, and at most $\lfloor \log_2 M \rfloor$ of each (Lemma 6.3). **[estimate]** A write to an existing peak slot costs about 5k gas, and a write to a new height about 22k, which happens at most $\lfloor \log_2 M \rfloor + 1$ times in a log's life.
- **Reading.** A light reader proves $M$ and the live peak slots against one header, at most $\lfloor \log_2 M \rfloor + 1$ slots given by the set bits of $M$, and computes the log's root itself.
- **Why no root is stored.** Storing it would cost every update another write, and a hash over every peak, to save each reader at most $\log_2 M$ slot proofs. Writes are paid on every update, whereas reads are paid only by readers.

With the log, a light reader reads histories and earlier slices against the header of its latest final $t$ (Proposition 3.8), and needs no state older than that, although on an optimistic rollup that header is itself about a week old (above). A reader can still prove against an earlier header if some node serves old state; that node can refuse, but it cannot lie.

A checkpoint's proof (item 2 above) can take $\mathsf{log}_{A,t}$ as a public input, in which case the directory it posts is a proven fold of an authenticated log.

**Bonds.** Holding an indexer to account (§3.5) needs no contract, since a fraud proof convinces anyone who checks it. If readers want compensation, however, an indexer can post a bond to a contract that pays out to the first valid fraud proof against a claim the indexer signed.
- **For lenses over an update log,** the contract checks the log opening against the current peaks of the log the lens reads. A position stays at the same index as the log grows, so a proof against an old claim remains valid forever. The contract also rebuilds the map opening, at $O(h+1)$ nodes.
- **[estimate]** The gas cost is dominated by hashing the map nodes. Each node has about $2^b$ entries in expectation, and at most $B_{\max}$.
- **For lenses over slices,** the point read needs directory and state openings, and while checking those on-chain is possible, its cost is not given here.
- **Exclusions after the claim.** A point read is taken as of the claim's $t$, for heads and exclusions alike (§3.5), so an exclude or restore made after $t$ does not make an honest claim provably wrong, and a publisher that excludes its own keys gains nothing against a bond. A contract may still accept proofs only against recent claims, to bound how long a bond stays exposed, but that is the contract's choice, since Proposition 3.15 holds for claims of any age.

## 6. Instantiating the Merkle DAGs

The naming function $N$ is SHA-256 over a canonical encoding (CIDv1). The map commitment $\mathsf{Com}$ is a **Merkle Search Tree** [AT19]:
- Each key $k$ has a level $\lfloor \mathsf{lz}(N(k)) / b \rfloor$, where $\mathsf{lz}$ counts leading zero bits and $2^b$ is the expected fanout.
- A node at level $\ell$ holds, in order, the keys of level exactly $\ell$ in its range, with their values.
- Between neighbouring keys, a child pointer names the level $\ell - 1$ subtree of the keys between them.

The level-$\ell$ nodes correspond one to one with the **gaps** between consecutive keys of level above $\ell$, together with the two ends, and the node for a gap $(a, b)$ is a function of $\ell$ and of the map restricted to $(a, b)$. The tree is therefore a function of the map alone, which gives unique representation, and its nodes are named by $N$, which gives binding. The height $h$ is the highest level of any key.

**Well-formedness.** A node is **well-formed** if:
- its keys are sorted;
- they lie inside its gap;
- each has level exactly $\ell$;
- there are at most $B_{\max}$ of them.

A reader accepts a tree, or part of one, only if every node it fetches is well-formed and matches its name, and checking a node costs $O(B_{\max})$ hashes. A reader that receives a whole tree also checks that rebuilding it from its entries gives the root.

**Lemma 6.0 (Honest nodes are small) [proof, with $N$ modelled as a random oracle].** If the names of the keys are uniformly random, a node holds $m$ or more entries with probability at most $(1 - 2^{-b})^m$. For $b = 4$ and $B_{\max} = 1024$, that is about $2^{-95}$ per node.

*Proof.* Take the keys of level at least $\ell$ in order. Each has level above $\ell$ independently, with probability $2^{-b}$. A level-$\ell$ node's entries are a maximal run of keys of level exactly $\ell$, so its length is geometric. $\square$

**Shape.** Names are random only if the party that chooses the keys does not search for them. A party that does choose keys can do two things:
- **raise the height:** it places a key at level $\ell$ by trying about $2^{b\ell}$ candidates. The height never exceeds $2\lambda / b$, because a name has $2\lambda$ bits.
- **fill a node:** it chooses keys of level 0, which costs nothing, since a fraction $1 - 2^{-b}$ of all keys have level 0. With the bound $B_{\max}$, however, such a tree is malformed rather than slow.

A party that chooses all of a tree's keys can thus make the tree costly to read, or even unreadable, but only for its own readers. This is why every tree in the protocol has its keys chosen by a single party:
- record keys and repo names, by the publisher;
- the publishers in an app's directory, by its acceptances, and so by whoever $\alpha_A$ lets accept.

A node of an app's directory can therefore be overfilled only by about $B_{\max}$ publishers whose heads the app accepted. If $\alpha_A$ lets anyone who holds a proof accept, without the approval of the owner or a validator, then whoever holds proofs chooses these keys, and filling a node costs about $B_{\max}$ acceptances, each paid for by whoever submits it. **[no proof]** Whether that cost suffices as a defence is not analysed. There is no directory of every publisher (§3.2), whose keys everyone would choose.

**Lemma 6.1 (Locality) [proof].** Let maps $D$ and $D'$ differ on a set $K$ of $\Delta$ keys, and let $h$ be the larger of their heights. Then at most $2\Delta(h+1)$ nodes of each tree are absent from the other.

*Proof.* Fix a level $\ell$. Take a level-$\ell$ node of $D$'s tree, with gap $(a, b)$, such that no key of $K$ lies in the closed interval $[a, b]$. Levels depend only on keys, so $a$ and $b$ are still consecutive keys of level above $\ell$ in $D'$, and $D'$ agrees with $D$ on $(a, b)$. So $D'$'s tree has the same node. A key of $K$ lies in the closed gap of at most two level-$\ell$ nodes: one if it is inside a gap, two if it is an end. So at most $2\Delta$ level-$\ell$ nodes are absent from the other tree. Sum over the $h + 1$ levels, and argue symmetrically for $D'$. $\square$

An update thus rewrites at most $2(h+1)$ nodes. Walking two trees together, and skipping pairs of subtrees with equal names, fetches $O(\Delta(h+1))$ nodes, because names are compared in the parent without fetching the child.

**Lemma 6.2 (Openings) [proof].** Let $I$ be an interval that holds $m$ keys of $D$. The nodes whose gaps meet $I$ form an opening of $D$ on $I$. $\mathsf{Check}$ accepts it if:
- every node is well-formed;
- every node matches the name its parent gives, up to the root;
- every child pointer whose gap meets $I$ was followed.

There are at most

$$
(h + 1) + \sum_{k \in D|_I} \mathsf{level}(k)
$$

such nodes. That is at most $(h+1)(m+1)$ in the worst case, and $(h+1) + m/(2^b - 1)$ in expectation when names are random.

*Counting.* At level $\ell$, the gaps that meet $I$ are separated by keys in $I$ of level above $\ell$, so there are at most one more than the number of such keys. Summing over levels gives $h + 1$, plus each key in $I$ counted once for every level below its own. For random names, $\mathbb{E}[\mathsf{level}(k)] = \sum_{j \ge 1} 2^{-bj} = 1/(2^b - 1)$.

*Binding.* Given the root, each node that $\mathsf{Check}$ reaches is fixed by its name, except with $\mathbf{Adv}^{\mathsf{bind}}_N$. Define the map a root commits to, $D_{\mathit{root}}(k)$, as what $\mathsf{Check}$ accepts on $[k, k]$, for any root, whoever built it. We show that every accepted opening on $I$ is $D_{\mathit{root}}|_I$, by induction over the nodes $\mathsf{Check}$ reaches. Each reached node passes the well-formedness checks, so its keys are sorted inside its gap, and a successful check below a node returns only keys inside that node's gap. For a key $k \in I$, the walk on $[k, k]$ follows exactly the child whose gap contains $k$. That gap meets $I$, so the walk on $I$ follows it too, and by induction both return the same value at $k$. Every other child the walk on $I$ follows returns no value at $k$, because $k$ is outside its gap. So the two openings agree at every key of $I$, and two accepted openings on one interval are equal. Correctness holds for the tree built from a sorted map: $\mathsf{Check}$ accepts every interval, with the map's restriction, so $D_{\mathsf{Com}(D)} = D$. A tree that fails the checks on some interval is **malformed**, and a read of it fails.

AT Protocol repositories use the same structure, but without the bound $B_{\max}$.

**The log commitment.** $\mathsf{LCom}$ is a **Merkle mountain range** [T16]:
- A leaf is $N(\texttt{leaf}, l_j)$, and an inner node is $N(\texttt{node}, \mathit{left}, \mathit{right})$.
- Write $M = 2^{e_1} + 2^{e_2} + \cdots$, with $e_1 > e_2 > \cdots$. The log is split, from left to right, into perfect binary trees of $2^{e_1}, 2^{e_2}, \ldots$ leaves. Their roots are the **peaks**.
- The root is $N(\texttt{mmr}, M, \mathit{peaks})$, and $\mathsf{st}(L) = (M, \mathit{peaks})$.

Appending a leaf adds a tree of one leaf, then merges the two rightmost trees for as long as they are the same size.

Unlike the tree for maps, the shape of a mountain range is fixed by $M$ alone; since nobody chooses it, nobody can grind it.

**Lemma 6.3 (Mountain ranges) [proof].** For a log of $M$ entries:
1. $\mathsf{LCom}$ is binding, and position binding holds, except with $\mathbf{Adv}^{\mathsf{bind}}_N$;
2. the state has at most $\lfloor \log_2 M \rfloor + 1$ peaks;
3. an opening of position $j$, made of the sibling path in its tree and the other peaks, has at most $2\lfloor \log_2 M \rfloor$ names, and is checked with as many hashes;
4. an append that makes the log $M$ entries long costs at most $\lfloor \log_2 M \rfloor$ merges. Appending $\Delta$ entries to a log of $M$ costs at most $\Delta + \lfloor \log_2 M \rfloor$ merges. So an append costs less than one merge on average.

*Proof.*
1. The root fixes $M$, and so the shape and every peak. Each peak is the root of a binary tree whose shape $M$ fixes. Two different logs of length $M$ differ at some leaf, and the paths from it to the root give two different inputs to $N$ with one output. Position binding is the same argument along one path. The tags $\texttt{leaf}$, $\texttt{node}$ and $\texttt{mmr}$ keep a leaf from being read as a node.
2. Peaks correspond to the set bits of $M$.
3. The sibling path has length $e \le \lfloor \log_2 M \rfloor$, and there are at most $\lfloor \log_2 M \rfloor$ other peaks.
4. Each merge removes one peak, and each append adds one. The number of peaks never falls below 1, and starts at most $\lfloor \log_2 M \rfloor + 1$. So $\Delta$ appends make at most $\Delta + \lfloor \log_2 M \rfloor$ merges. An append to a log of $M - 1$ entries merges once for each trailing one bit of $M - 1$, which is at most $\lfloor \log_2 M \rfloor$.

$\square$

## 7. Scope

**Missing proofs.** The following claims are stated without a full proof:
- **Fraud proofs for lenses that are not pointwise and key-revealing (§3.5).** No succinct construction is given.
- **Embedding models (§3.4).** They are assumed to be deterministic to the bit.
- **Validation, acceptance, and exclusions (§3.2, §5).** The cost of checking a witness under $\nu_V$, $\alpha_A$, or $\chi_A$ on chain is not given, beyond the estimates of §5. Proposition 3.2 and Theorem 2 bind a witness to one change only for rules that read the whole statement. What a validation shows about content is whatever its evidence shows: proofs that a state satisfies a rule, incrementally or not, and validators whose hardware attests their code, are named as kinds of evidence, but neither is constructed or analysed. Nor is the shape of an app's directory when anyone holding a proof may accept (§6). How hosts act on exclusions is left to implementations, beyond a grace period (§2).
- **Commit epochs (§3.2).** An honest publisher's update is valid only if the ordering includes it within $W$ epochs of making the commit. That delay is assumed, not analysed. A late update fails, and its publisher commits again.
- **Watchers (§3.5).** The conditions under which a watcher's fraud proof reaches a reader are argued, not proven to be sufficient. Neither cross-checking nor publishing claims is analysed against indexers that collude.
- **Bounded trees (§3.5).** There is no succinct proof that an entry was omitted, no bound on the expected cost of a search, and no analysis of what the pattern of fetched nodes reveals about a query.
- **Shape of sub-log views (§3.5).** Whether a publisher can usefully choose its address, or the indices its updates land at, is not analysed.
- **Nested directories (Definition 3.3).** No bound is given for opening an interval of names that spans many subdirectories, beyond Lemma 6.2 applied to each one.
- **Whole histories (§3.3).** No bound tighter than $p$ independent openings is given for openings that share a tree.
- **The join lens (§3.4).** Neither its correctness nor its cost is proven.
- **Expected costs (Lemma 6.0, Lemma 6.2, §3.6).** They assume that names are random, and that keys are not searched for. Worst-case bounds are given alongside.
- **§5.** Storage-proof sizes and gas costs are estimates. The light-client protocol is assumed, not analysed. A trustless light reader on an optimistic rollup has $\delta$ of about seven days, and needs a node that serves archive state.

This document omits the following, each of which builds upon it:
- how a light reader verifies block headers;
- checkpoints of a whole app's directory (§5);
- proofs that a view is correct (§3.4), for lenses too large to recompute;
- exclusions of key ranges or prefixes, for example as one exclusion root per repo, replaced atomically;
- constructions of validation rules and their evidence: proofs that a state satisfies a rule, including rules relating its records, incrementally from a state already validated, and validators that attest to their code. Rules on one record can also be checked as they are read, as validation lenses (§3.4), but rules over several records then have no succinct fraud proof;
- sealed (encrypted) data, and who may read it, including licenses that restrict which apps may present a repo, and acceptance of data that the acceptor cannot read.

# Appendix A — Agents and a semantic CDN

This appendix sketches how a software agent uses the protocol: how it finds, among every view on the network, the ones that can answer a question, and how it reads them, through a single server and without trusting any index. It is a design built on Part I, not part of the protocol. Its results are tagged as in §1.1.

### A.1 One server for every app

An agent connects to one server, and through it to every app. The server does three things:
1. **It lists apps.** It reads the apps from the registry (Definition 3.1), and each app's **manifest**: what the app is for, the validation rules it requires, and the views it serves, each named by its lens $N(\texttt{lens}, L)$, with recent claims for it (Definition 3.13). A manifest is itself a record, in a repo of the app's owner, so the agent reads it as it reads any record, and its history is public.
2. **It mounts views.** It fetches a view's nodes from any host, and checks them against a claim's root.
3. **It offers the same tools for every view:** describe what a view holds, search it by meaning, get one record, find records similar to one, count the values of a field, and browse without a query.

One server suffices because every view is a state of the same kind (§3.4): a map from keys to records, some of which carry vectors under a named model. The tools that read one view read every view, so an app needs no code of its own, and no page or browser, to be usable by an agent. It publishes data and claims, and the agent does the rest.

What remains is to choose which views to mount. A network may hold millions of views, and an agent can neither mount them all nor trust a search engine to choose for it. The rest of this appendix answers that question.

### A.2 The semantic CDN

A content delivery network serves data from wherever it is cached, by name. Every node in Fangorn is named by its content (§1.3), so any host can already serve as such a network, and a reader checks what it receives. What such a network cannot do is say *which* names to ask for. A **semantic CDN** adds that: it routes a query to the data closest to it in meaning, and then delivers that data by name, while the routing, like the data, can be checked rather than trusted.

It rests on two structures, a clustered view and its coverage, and one algorithm.

**Definition A.1 (Clustered view).** Let $E$ be an embedding model (§3.4), and $C = (\mu_1, \ldots, \mu_m)$ a sequence of **centres** in $\mathbb{R}^d$. For a selector $S$, the **clustered view** is the lens $L = (S, f)$, with $E$ and $C$ named in it, given by

$$
\tau(x, r) = (\kappa(r),\ x), \qquad g(r) = E(r), \qquad \kappa(r) = \min \{\, i : \Vert E(r) - \mu_i \Vert \le \Vert E(r) - \mu_{i'} \Vert \text{ for all } i' \,\}
$$

so that each record is filed, with its vector, under its nearest centre, and ties go to the lowest index. Its **cluster** $i$ is the set of its entries whose keys begin with $i$.

The lens is pointwise and key-revealing (Definitions 3.11 and 3.14), since $x$ is part of each key, so it inherits everything Part I gives such lenses. In particular:
- **A cluster is one opening.** Its keys form an interval, so one opening of the view's root returns the whole cluster, with proof that no entry was added or left out (Definition 1.6). This is what the bounded tree lacks: a tree ordered by geometry cannot prove that an entry is absent (§3.5), whereas a clustered view, being ordered by key, can.
- **A wrong view has a fraud proof.** A record filed under the wrong cluster, given a wrong vector, or omitted is refuted by one opening and one point read (Proposition 3.15), given the determinism of $E$ that §3.4 assumes. Computing $\kappa$ in the fixed-point arithmetic of $E$ makes it deterministic as well.
- **It follows by change.** A changed record moves at most one entry (Proposition 3.12).

The centres are part of the lens, so changing them makes a new lens with a new name. A view is reclustered when its centres no longer fit its data, and that, like any recomputation, costs reading its slice once.

**Definition A.2 (Coverage).** A **coverage** of a clustered view is a signed value

$$
\mathsf{cov} = \big(\iota,\ N(\texttt{lens}, L),\ t,\ R,\ (\varepsilon_1, \ldots, \varepsilon_m)\big)
$$

which is a claim (Definition 3.13) that $R$ is the root of the view at $t$, together with a **radius** $\varepsilon_i$ for each cluster. The coverage is **sound** if every vector $v$ in cluster $i$ has $\Vert v - \mu_i \Vert \le \varepsilon_i$. For a query $q$ with $\Vert q \Vert \le 1$, the **bound** of cluster $i$ is $\beta_i(q) = \langle q, \mu_i \rangle + \varepsilon_i$.

A coverage is small: $m$ centres and radii, a few kilobytes for $m = 8$ and $d = 256$ at one byte per coordinate, whatever the size of the view.

**Proposition A.3 (Coverages are checkable) [proof].** If a coverage is not sound, a single opening of $R$ at one entry proves it. If it is sound, then for every $v$ in cluster $i$, $\langle q, v \rangle \le \beta_i(q)$.

*Proof.* If some $v$ in cluster $i$ has $\Vert v - \mu_i \Vert > \varepsilon_i$, the opening of $R$ at its key shows $v$, and the key shows $i$. Anyone checks the distance, as for a false bound in a bounded tree (§3.5). The second claim is Lemma 3.17 applied to the cluster. $\square$

A radius can be honest and still loose. That is not fraud, but it draws queries to the cluster that it cannot answer well. An indexer that keeps a coverage current grows a radius when a far vector arrives, and tightens it by recomputing.

**Routing.** An agent holds coverages of many clustered views, all under the same model $E$. To find the $j$ records closest to $q$ across all of them, it runs $\mathsf{Route}$. Here $Q$ holds every cluster of every view, each with its bound:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{Route}(q, j) \qquad (\Vert q \Vert \le 1;\ \text{sound coverages under one model } E) \\
\hline
1: & Q \gets \{\, (V, i, \beta_i(q)) : \text{cluster } i \text{ of each view } V \,\};\ T \gets \emptyset \\
2: & \textbf{while } Q \neq \emptyset\textbf{ do} \\
3: & \quad (V, i, \beta) \gets \text{the element of } Q \text{ with the highest bound};\ \text{remove it from } Q \\
4: & \quad \textbf{if } |T| = j \wedge \beta < \min_{(x, v) \in T} \langle q, v \rangle\textbf{ then return } T \\
5: & \quad Z \gets \text{an opening of } V\text{'s root on cluster } i\text{, from any host};\ \textbf{require } \mathsf{Check} \\
6: & \quad \text{add each } (x, v) \in Z \text{ to } T\text{, keeping the } j \text{ best} \\
7: & \textbf{return } T \\
\hline
\end{array}
$$

**Proposition A.4 (Routing is exact and complete) [proof].** On sound coverages, $\mathsf{Route}(q, j)$ returns $j$ entries of highest score among all entries of all the views, or all of them if there are fewer, except with the probability that opening binding fails. Every cluster it opens has a bound at least the $j$-th best score.

*Proof.* By opening binding, line 5 yields exactly cluster $i$ of $V$, every entry and no other. Every entry not yet seen lies in a cluster still in $Q$, and by Proposition A.3 its score is at most that cluster's bound, which is at most $\beta$ at line 3. When line 4 returns, every unseen entry therefore scores below every entry of $T$. A cluster is opened only if line 4 did not return, that is, only if its bound is at least the current $j$-th best score, which never decreases. $\square$

**Recursion.** The coverages are themselves data. The **directory** of a semantic CDN is a view whose entries are the clusters of the views it lists, each keyed by $(N(\texttt{lens}, L), i)$, with value $(\mu_i, \varepsilon_i)$ and the coverage it comes from. It is a lens over manifests and claims, and like any view it can be clustered in turn. Let an upper centre $\nu$ gather lower clusters $i$ with centres $\mu_i$ and radii $\varepsilon_i$, and give it the radius

$$
\delta = \max_i \big( \Vert \mu_i - \nu \Vert + \varepsilon_i \big)
$$

By the triangle inequality, every vector of every gathered cluster lies within $\delta$ of $\nu$, so the upper level is sound whenever the lower ones are, and $\mathsf{Route}$ runs unchanged over it, opening an upper cluster to obtain lower ones. A false $\delta$ has a fraud proof of one upper entry. The network's search index is thus one tree of clustered views, whose upper levels hold views and whose lower levels hold records. Each level is a view that anyone may compute, serve, or refute, and nobody holds anyone's rows.

Nor is there one directory. Each is a lens over public manifests, and whoever builds one chooses which views it lists, as a curation. Agents choose among directories as readers choose among indexers (§3.5). A directory may list every view that some app presents, or every repo that passed some rule, read from the rule's log (§3.2).

**What the semantic CDN guarantees.** Together, these give an agent four properties that a search engine does not:
- **No authority.** Every structure it reads is a view or a claim, so a wrong routing decision is either a false radius, refuted by one opening, or a loose one, which costs the agent fetches but not correctness.
- **Exactness.** On sound coverages, the agent finds the best records in the network without opening any cluster that cannot hold one (Proposition A.4).
- **Privacy.** The agent embeds its query on its own device and ranks every record itself, and no host sees the query. Hosts see which clusters it opens, which reveals roughly where the query lies, as for a bounded tree (§3.5). An agent that fetches a fixed number of clusters, or a whole view as a bundle, reveals less.
- **Delivery by name.** Once routed, every fetch is by name, so any host, cache, or peer can serve it, and the agent checks it.

**Cost.** Routing over $n$ views of $m$ clusters each costs $nm$ inner products, a few milliseconds for $n = 10^4$ and $m = 8$, before anything is fetched. A directory with a level above it reduces this to the upper clusters, plus the lower clusters of those opened. Fetching costs the clusters opened, each one opening (Lemma 6.2).

### A.3 Cartridges

A mounted view is a **cartridge**: a lens name, a clock value $t$, a root, and the clusters or shards of it that the agent has fetched. An agent's working knowledge is the set of cartridges it has mounted, which has four properties:
- **Hot-swappable.** An agent mounts a view when a task needs it, and drops it when the task ends, with nothing installed and no server run, by anyone.
- **Composable.** An agent may hold several cartridges at once, and put one query to all of them. Their scores are comparable when the views name the same embedding model; otherwise the agent compares their records, not their scores.
- **Pinned.** An answer cites the root and clock value it was drawn from, so that another agent, or a person, can read exactly the same data, and check the answer, at any later time (Corollary 4.1).
- **Checked, and current.** Each fetch is checked against its root, and the agent trusts the claim for that root as far as it chooses (§3.5). To move to a newer claim, it fetches only what changed (Proposition 3.12).

An agent is also an author, and so may publish: its notes, its findings, or a model of what its user likes, as repos of its own. Views of them are cartridges that the agent itself can mount on another device, or under another model, and that others can mount if it shares them. Such data can be validated against rules, and accepted by apps, as any other can. An agent's memory is thereby held by its owner's key, rather than by the platform that runs the agent.

### A.4 What is open

- **A shared model.** Routing compares scores across views, so every view in one semantic CDN must use the same model $E$, bit for bit (§3.4). Views under different models form separate networks, or need a mapping between models, which is not given here.
- **Choosing centres.** How centres should be chosen, how often a view should be reclustered, and how tight radii can be kept as data changes, are not analysed. These affect cost, not correctness.
- **Counts.** A coverage could also state each cluster's size, which an agent would use to estimate fetch costs. A size is an aggregate, checked by anyone who reads the cluster, but it has no succinct fraud proof.
- **What hosts learn.** Which clusters an agent opens reveals roughly what it asked. How much a fixed fetch pattern hides is not analysed.
- **Paid and sealed views.** These are left to later work (§7).

## References

| Key | Reference |
| --- | --- |
| [AB09] | S. Arora, B. Barak. Computational Complexity: A Modern Approach. Cambridge University Press, 2009 |
| [AT19] | A. Auvolat, F. Taïani. Merkle Search Trees: Efficient State-Based CRDTs in Open Networks. SRDS 2019 |
| [CER] | Ceramic. Protocol documentation, legacy specification, and the rust-ceramic pipeline design. developers.ceramic.network, github.com/ceramicnetwork, accessed 2026-10-13 |
| [CIP124] | Ceramic. CIP-124: Recon, tunable eventually-consistent event sharing. cips.ceramic.network, draft |
| [FC] | Farcaster. Protocol specification and Snapchain documentation. github.com/farcasterxyz, accessed 2026-10-13 |
| [G01] | O. Goldreich. Foundations of Cryptography, Volume 1: Basic Tools. Cambridge University Press, 2001 |
| [IPNS] | IPFS. IPNS record and protocol specification. specs.ipfs.tech/ipns, accessed 2026-10-13 |
| [KFH+24] | M. Kleppmann, P. Frazee, J. Gold, J. Graber, D. Holmgren, D. Ivy, J. Johnson, B. Newbold, J. Volpert. Bluesky and the AT Protocol: Usable Decentralized Social Media. ACM CoNEXT Workshop on the Decentralization of the Internet (DIN '24), 2024. arXiv:2402.03239 |
| [L78] | L. Lamport. Time, Clocks, and the Ordering of Events in a Distributed System. CACM 21(7), 1978 |
| [LLK13] | B. Laurie, A. Langley, E. Kasper. Certificate Transparency. RFC 6962, 2013 |
| [MBB+15] | M. Melara, A. Blankstein, J. Bonneau, E. Felten, M. Freedman. CONIKS: Bringing Key Transparency to End Users. USENIX Security 2015 |
| [MCRDT20] | H. Sanjuán, S. Pöyhtäri, P. Teixeira, I. Psaras. Merkle-CRDTs: Merkle-DAGs meet CRDTs. arXiv:2004.00107, 2020 |
| [NIP01] | Nostr. NIP-01: Basic protocol flow description. github.com/nostr-protocol/nips |
| [T16] | P. Todd. Merkle Mountain Ranges. OpenTimestamps, 2016 |
| [TG] | The Graph. Documentation: indexing overview and glossary. thegraph.com/docs, accessed 2026-10-13 |
| [TBL] | Tableland. Documentation. docs.tableland.xyz, accessed 2026-10-13 |
