# Fangorn I: Verifiable Data without a Platform

**Author: Tony Riemer (driemworks@fangorn.network) | Fangorn**

## 0. Introduction

Most data on the web lives on platforms. A platform stores the data, declares which version is current, decides who may write it and who may read it, and runs the search through which it is found. Because a single party performs all of these functions, readers must trust it for all of them: that what they read is what was written, that it is current and complete, and that search shows them what is actually there.

We seek the same functions without the platform. In our setting, data is held by hosts whom nobody needs to trust, yet anyone can check that the data they receive is exactly what its publisher committed, and that it is the current version, or a given past one. Anyone may index the data and serve searches over it without thereby becoming a gatekeeper, since what an index serves is a function of public data that anyone can recompute. Data belongs to no app. An app is a curator: a publisher like any other, whose data cites, selects and arranges what other publishers committed. It neither stores nor admits nor gates their data, and two apps that present the same record present the same bytes, checked against the same head.

**Part I** presents a general model in two parts:

1. **Data.** A publisher's state is a Merkle DAG, named by its root.
2. **History.** Each publisher's commits form a Merkle clock, and an ordering service places every update into a single total order, providing a logical clock. A registry, run over that ordering, keeps one thing: the head of every repo. Together, data and history define one **global state** at every clock value, any slice of which, current or historic, anyone can read and derive views from without trusting the hosts that serve it. An app's curation is itself a repo, so it is read as any slice is, and each record it cites is checked against the head it names. **Indexers** compute and serve views but hold no authority, since a view is a function of public data, which anyone can recompute.

**Part II** instantiates the model:

- the ordering service is a blockchain, which runs the registry and authenticates directories and update logs to light readers;
- the Merkle DAG for states is a Merkle Search Tree, and the commitment to the update log is a Merkle mountain range.

**Appendix A** sketches how a software agent uses the protocol through a single server, and defines a **semantic CDN**: clustered views and their coverages, by which an agent routes a query to the closest records in the whole network, exactly, and fetches them from any host, without trusting an index. **Appendix B** lets a repo change faster than the ordering: a publisher signs micro-commits at any rate and anchors them periodically, and a publisher who anchors something other than what it signed can be proven to have done so. **Appendix C** makes indexers accountable: for the common kinds of view, such as filters, indexes and embeddings, a wrong view has a fraud proof of two openings that anyone can check.

### 0.1 Our Contributions

We introduce Fangorn, a general-purpose protocol for data in an _agentic_ era. Fangorn organizes data into **repos**, each holding one publisher's data. Each repo is a Merkle clock with a single writer (§3.1), and an _ordering service_ places the heads of every repo into one total order (§3.2). As each repo has one writer, and the order settles which update comes first, publishers never coordinate with one another, and no CRDT merge is needed. Repos belong to no app, and name no rule. Our contributions are as follows.

1. **One ordering of every publisher's heads.** The registry is a deterministic state machine over the ordering with a single operation, an update (Definition 3.1). Anyone who holds the ordering computes the same heads. Every head was set by its publisher (Theorem 2), and each repo's history is a single chain in which no head occurs twice, so that a signed update applies at most once (Theorem 3). A past global state is as well defined as the present one.
2. **Reads proven current and complete to a light reader.** A reader holding only a checkpoint of the ordering can read a _slice_ of any publisher's data, and even if every host and server is adversarial, it obtains exactly that slice, or $\mathsf{fail}$ (Theorem 4). Whereas a signed commit alone proves what a repo holds, this proves that it is the latest, and that nothing in the slice was left out. The update log is a Merkle mountain range, so a slice as of any past time costs a few logarithmic openings against the latest checkpoint (Proposition 3.8, Corollary 4.1).
3. **Curation as data.** An app is a repo whose records **cite** records of other repos at named heads (§2). A reader checks a citation with one log opening and one state opening (Proposition 3.5), so an app can neither forge nor alter what it presents, while choosing, arranging and annotating it as it likes, and withdrawing it by an ordinary update. Validation is curation too: a validator is a publisher whose citations carry a verdict. No app admits a publisher, and no publisher needs an app to publish.
4. **Indexers without authority.** A view is a deterministic function of public data, a **lens** (§3.4), so every honest party that computes it obtains the same root (Proposition 3.10), and anyone can check an indexer by recomputing, or by asking another (§3.5). For pointwise, key-revealing lenses, a wrong view also has a fraud proof of one opening and one point read (Appendix C).
5. **Search by meaning that can be checked.** An embedding view can be served as a **bundle** of shards, each checked against the view's root, so that a reader ranks every record itself, exactly, and its query never leaves its device. For a view too large to fetch whole, a **bounded tree** lets a reader find the closest records without fetching every vector, exactly on a sound tree (Lemma 3.15). Appendix A applies the same bounds one level up, to clustered views, so that an agent finds the closest records across every view on the network.
6. **An instantiation, with costs.** Part II runs the registry as a program on a blockchain (§5). States are Merkle Search Trees, with a bound on node size that turns shape attacks into malformed trees, which harm only the party that chose the keys (§6). The update log is a Merkle mountain range kept as peaks in contract storage, and a light reader proves heads and logs with storage proofs, requiring no prover. §3.6 gives the cost of every operation.

Fangorn does not keep data available; that is left to hosts, and any storage network may serve as one (§2). Nor does it decide who may _read_ data, which [WP2] gives. Each result is tagged with its status (§1.1), and §7 lists every claim that lacks a full proof.

### 0.2 Related Work and Further Applications

Almost every element of this design is rooted in existing work. What we have not found is a single system that provides all four of the following together: a total order over every publisher's heads; a proof, to a reader holding only a checkpoint, that a slice is current and complete; curation that cites data rather than holding it, so that no app stands between a publisher and its readers; and indexes that anyone can recompute, with fraud proofs for the common kinds. We compare the systems below on those four properties.

**AT Protocol** [KFH+24]. Each account's data is a signed repository, held by a host of the account's choosing and structured as a Merkle Search Tree [AT19], the same structure as in §6. Relays merge every repository into one stream of events, which AppViews then index. A signed commit proves what a repository holds, but not that it is the latest commit, so a reader trusts a relay to have seen every event, and an AppView to index them faithfully. Moderation is performed by labellers and by whoever hosts or indexes the data, outside the protocol. §3.5 takes on the roles of AppView and labeller, and replaces trust in them with checkable views.

**Ceramic** [CER]. Each document is a stream: a log of signed events linked by hashes, which is to say a Merkle clock with one writer. An anchor service places a Merkle root over batches of events on a chain, which proves that an event existed before a given block, a weaker guarantee than proving it is the latest. When a stream forks, nodes pick a branch, with the earliest anchor winning, so a writer who withholds an earlier fork can later reveal it and undo the updates made after it. Nodes sync by reconciling sets over ranges of event identifiers [CIP124], ordered by model, then controller, then stream, much like the two levels of §3.2. Sync reaches the latest events with high probability, but not with proof. Anyone may write documents of any model, there is no moderation in the protocol, and query results are trusted to the node that serves them. Batching makes Ceramic's writes far cheaper than ours; we pay one transaction per update (§5), and that is the price of a head that a reader can prove is current.

**Farcaster** [FC]. Identities and their signing keys are registered on a chain, while messages are held off-chain by a network of nodes. That network first merged messages as CRDTs, and Snapchain now orders them by consensus, so that data and its order live in the same network, with limits on how much each account may store. Fangorn, by contrast, orders only heads and leaves data to untrusted hosts. Publishers here need no admission to write, and no app keeps a registry of its publishers: what an app presents is what its curator cites.

**Nostr** [NIP01]. Signed events are sent to relays that anyone can run. There is no order across relays and no way to know that a relay returned every event, and each relay moderates for itself.

<!-- **Merkle-CRDTs and IPNS** [MCRDT20, IPNS]. Merkle clocks give a partial order that needs no coordination, and §1.5 makes use of them. Without a total order, however, two replicas cannot tell whether they hold the same latest state. IPNS signs a mutable pointer to a name with a sequence number, but a resolver cannot distinguish a stale record from the latest one.

**Transparency logs** [LLK13, MBB+15]. Certificate Transparency appends to a log and proves inclusion and consistency, while CONIKS proves to each user the current value of its own key in a directory. Our update logs and directories (§3.2) play the same roles, with the ordering service taking the place of gossip as the guard against a log showing different readers different histories. -->

**The Graph and Tableland** [TG, TBL]. Both index data whose order is fixed by a chain. In The Graph, indexers publish proofs of indexing, and an arbitrator settles disputes; Tableland's validators turn SQL statements recorded on a chain into tables. In both, a reader trusts either the node that answers a query or a dispute process with a human in the loop. Proposition C.2, by contrast, gives a proof that a claim is wrong, which anyone can check, for pointwise views.

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

_Proof._ Suppose $\mathcal{N}$ has a cycle $n_{\alpha_1} \to n_{\alpha_2} \to \cdots \to n_{\alpha_k} \to n_{\alpha_1}$. Take the node $n_{\alpha_i}$ on it whose name was queried first. Its input contains the link $\alpha_{i+1}$, indices taken mod $k$. $\alpha_{i+1}$ is the output of a query made later. So some query's input contains the output of a later query. For any one pair of queries, that happens with probability at most $2^{-2\lambda}$. There are at most $q^2$ pairs. $\square$

Binding alone (Definition 1.1) does not yield Lemma 1.4. A cycle requires not a collision but a value that contains its own name, whether directly or through other nodes, and ruling it out requires that outputs of $N$ cannot be predicted before they are computed. This is the formal content of the phrase "built from the leaves up".

**Lemma 1.5 (A name identifies its sub-DAG) [proof].** Let $\mathcal{N}$ and $\mathcal{N}'$ be Merkle DAGs that both contain a node named $\alpha$. If $\mathcal{N}{\downarrow}\alpha \neq \mathcal{N}'{\downarrow}\alpha$, then $\mathcal{N} \cup \mathcal{N}'$ contains two different nodes with the same name, which is a collision of $N$.

_Proof._ Without loss of generality, some node $m$ of $\mathcal{N}{\downarrow}\alpha$ is not in $\mathcal{N}'{\downarrow}\alpha$. Take a path $n_\alpha = m_0 \to m_1 \to \cdots \to m_j = m$ in $\mathcal{N}$. We build, step by step, nodes $m'_0, m'_1, \ldots$ of $\mathcal{N}'{\downarrow}\alpha$, with $m'_i$ named like $m_i$:

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

An NP relation separates what is claimed from the evidence for it. A witness may be hard to produce, yet anyone can check it quickly, and the relation is indifferent to how it was found. The conditions under which sealed data can be read are NP relations [WP2], wherein the statement names what is to be read, and the witness is evidence that the reader may read it, such as a payment recorded in the ordering, or a proof of membership.

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

**Citations.** A **citation** is a record whose payload includes a reference

$$
\mathit{ref} = (\rho,\ i,\ h,\ k)
$$

to the record at key $k$ of repo $\rho$, at position $i$ of its history, whose head is $h$ (§3.2). It may cite a whole repo, with $k = \bot$. Its other fields are the citer's own: a rank, a tag, a review, a verdict. Because a citation names the head as well as the position, it binds the content it refers to, and anyone can check it against the ordering (Proposition 3.5).

**Apps.** An **app** is a repo of citations, written by its **curator**, together with a **manifest**: a record of the same repo that says what the app is for, which lenses it serves (§3.4), and where it is paid [WP2, §2.4]. What the app presents is what its citations name. Its curator adds data by citing it, moves to a newer version by citing a later position, and withdraws data by deleting the citation, each an ordinary update of its own repo. An app holds no data of others, dictates no schema, and admits no one: it may cite any publisher's data, and no publisher needs an app to publish. Since an app is a repo, everything this document says about reading, history and views applies to it unchanged, and an app may cite other apps.

**Validation.** A rule about data, such as conformance to a schema, or terms that only a person or a model can judge, is checked by a **validator**: a publisher whose citations carry a verdict. Its evidence may be the data itself, a succinct proof, or an attestation from hardware that runs the rule's code, and it is exactly as strong as that evidence. An app that requires a rule cites what the validators it trusts have passed, or reads their repos through a lens (§3.4). A rule on single records may also be checked at read time, by a lens, which anyone may do.

**Who may present, and who may moderate.** A curator presents what it chooses, and withdraws what it chooses, and a repo has one writer. An app that wants a moderation set rather than one curator makes its curator a program on the ordering (§5) that writes the repo when its rule is met, such as a threshold of moderators' signatures. A publisher cannot stop an app from citing what it published, any more than a web page can stop a link, but it can withhold payment from it [WP2, §2.4], and data that only some may read is sealed, under conditions its publisher sets [WP2].

Every node of every DAG is held by untrusted hosts and fetched by name, and what a host keeps or drops is its own decision, under a policy of its own (§7). Because a node can be shared with data that the host still serves, a host should drop only names that no state it serves reaches. A publisher remains responsible for pinning its own data: data that no host serves causes a read to $\mathsf{fail}$ (Theorem 4), never to return something else. Unpinning is otherwise a matter for implementations.

## 3. History and state

### 3.1 Each repo is a Merkle clock

A **commit** is an event $\gamma = (e, \mathit{parent}, \mathit{root})$:

- $e$ is the epoch in which it was made, which the registry checks against the ordering's clock (§3.2);
- $\mathit{parent}$ is the name of the previous commit, or $\bot$, which the registry also checks;
- $\mathit{root}$ is the root of the new state.

A repo's commits form a Merkle clock with one writer, and hence a chain. A repo's **head** is the name $N(\gamma)$ of its current commit. For a head $h$, $M_h$ is the state committed by its commit's root, and $M_\bot = \emptyset$. A reader holding a head thereby holds, by name, the repo's whole history and its current state.

What the Merkle clock cannot say on its own is whether a head is the _latest_. A host can withhold newer commits, and nothing in the DAG reveals that it has done so. It is the ordering service that answers this question. A publisher whose data changes faster than the ordering accepts entries may commit between anchors, with signed micro-commits that settle at the next anchor (Appendix B).

### 3.2 The ordering service orders heads

The ordering service stores entries but does not interpret them. Their meaning is given instead by a deterministic state machine run over the ordering, the **registry**, whose state holds the head of every repo. A registry has two parameters, fixed when it is deployed: an **identifier** $\iota$ that no other registry shares, such as a chain's identifier together with a program's address, and a **window** of $W \ge 1$ epochs.

**Definition 3.1 (Registry).** A **registry state** is a pair

$$
R = (\mathcal{H},\ \mathcal{U})
$$

where:

- $\mathcal{H}$ maps a repo $\rho$ to its position and its head, $(\mathit{pos}, h)$, with $\mathcal{H}(\rho) = (0, \bot)$ for a repo never written;
- $\mathcal{U}$ is the **update log**, a sequence of entries, one for each valid update of any repo.

The initial state $R_0$ consists of an empty map and an empty log. One ordering may serve many registries. For a registry $\iota$, let $\mathcal{O}_\iota$ be the subsequence of $\mathcal{O}$ consisting of entries with destination $d = \iota$, and $\mathsf{Read}_\iota(t)$ the corresponding subsequence of $\mathsf{Read}(t)$. The registry $\iota$ is a function of $\mathcal{O}_\iota$ alone, and since the destination is fixed within it, we write an entry of $\mathcal{O}_\iota$ as $o = (t, a, \mathit{op})$. Each such entry carries one operation, an update.

The destination is not checked by $\mathsf{Apply}$; rather, it selects the entries on which $\mathsf{Apply}$ is run. Entries are bound to it by Assumption O.2: an entry of $\mathcal{O}_{\iota'}$ with author $a$ and operation $\mathit{op}$ requires a signature of $a$ on $(\iota', \mathit{op})$, and a signature on $(\iota, \mathit{op})$ for $\iota \neq \iota'$ is not one. Except with negligible probability, then, every entry of $\mathcal{O}_{\iota'}$ was addressed to $\iota'$ by its author, and no entry made for $\iota$ is also an entry of $\mathcal{O}_{\iota'}$. A value signed apart from the ordering, such as a micro-commit (Appendix B) or a publisher's terms [WP2, §2.4], names $\iota$ itself, so that it means nothing in another registry.

The transition $\mathsf{Apply}$ runs $o$ against $R$:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{Apply}(R, o) \qquad (o = (t, a, \mathit{op}) \in \mathcal{O}_\iota;\ \text{a failed } \textbf{require} \text{ returns } R \text{ unchanged}) \\
\hline
1: & \textbf{case } \mathit{op} = \mathsf{update}(s, e, \mathit{parent}, \mathit{root})\textbf{: } P \gets a;\ (i, h) \gets \mathcal{H}(P, s);\ \textbf{require } \mathit{parent} = h \wedge e(t) - W \le e \le e(t) \\
2: & \quad h' \gets N(e, \mathit{parent}, \mathit{root});\ \mathcal{H}(P, s) \gets (i + 1, h');\ \mathcal{U} \gets \mathcal{U} \Vert (P, s, i + 1, h', t) \\
3: & \textbf{return } R \\
\hline
\end{array}
$$

The $\textbf{require}$ on line 1 is the update's **guard**. If it holds, $o$ is **valid**; otherwise $\mathsf{Apply}$ returns $R$ unchanged, and $o$ is **invalid**.

**Updates.** $\mathsf{update}(s, e, \mathit{parent}, \mathit{root})$, authored by publisher $P$, moves repo $(P, s)$ from its head $h$ to the head $h' = N(e, \mathit{parent}, \mathit{root})$ of a new commit whose parent is $h$. $\mathsf{Apply}$ computes that name from the commit's three fields, and never fetches a commit or a state. Because an update applies only while its parent is the head, and no head occurs twice (Theorem 3), a signed update applies at most once: replayed after the repo has moved on, it fails the guard, even if the repo has since returned to the same state through another commit, and returning to an old state therefore takes a fresh commit. No rule or app is consulted, and an update names neither. Any author may commit to its own repos, at its own cost.

The registry has no other operation. What a platform would keep in a registry, such as which data an app presents, which data passed a rule, and what an app withdrew, is here the data of curators and validators (§2), committed by updates like any other.

The **registry at $t$**, $R_t$, is the result of applying $\mathsf{Apply}$ to the entries of $\mathsf{Read}_\iota(t)$ in order, starting from $R_0$. $H_t(\rho)$ is the **head** of repo $\rho$ at $t$ (§3.1), and $\mathit{pos}_t(\rho)$ its **position**: $(\mathit{pos}_t(\rho), H_t(\rho)) = \mathcal{H}(\rho)$ in $R_t$. For a repo never written, they are $0$ and $\bot$. $\mathcal{U}_t$ is $\mathcal{U}$ in $R_t$.

**Cost.** A valid update changes one map entry and appends one log entry. Its guard costs one lookup, one name and one epoch.

Invalid entries change nothing. The **history** of a repo is the sequence of heads $h_1, h_2, \ldots$ set by its valid updates, wherein $h_i$ is at **position** $i$. Validity, and hence $R_t$, is a function of $\mathcal{O}$ alone. Anyone who holds the ordering computes the same heads, and no party needs to be trusted to enforce the rules.

**Commit epochs.** The guard on line 1 ties a commit's epoch to the ordering's clock. A publisher makes a commit before the ordering includes it, and does not choose when that happens, so the window allows $W$ epochs of lag; requiring equality would invalidate every update that crosses an epoch boundary. A deployment sets $W$ by time, such that $W\eta$ covers the longest inclusion delay it intends to survive, for example a day on a rollup whose forced inclusion takes that long (§5). An update that lands later is invalid: the head stays where it was, and the publisher commits again under the current epoch. Whoever orders entries can delay an update, which is the liveness that Assumption O leaves to the ordering, but cannot make a late update land. Since every head is the name of a commit for which its publisher signed, only $P$ can make $(P, s)$ unreadable, whether by withholding a commit or its state or by committing a malformed one (§6), and doing so harms only that repo, and the apps that cite it.

**The global state.** The **global state** at clock value $t$ is the map

$$
\mathcal{G}_t(\rho, k) = M_{H_t(\rho)}(k)
$$

over every repo $\rho$ and key $k$, undefined wherever $M_{H_t(\rho)}$ is. It records what was written, and nothing else, and no reading of it depends on an app.

The global state is a function of $\mathsf{Read}(t)$ and of values fetched by name. By Assumption O, every honest party that evaluates it at a **final** $t$, one more than $\delta$ steps old, uses the same heads, and by Theorem 1, no host can make those heads open to other states. Every honest party therefore obtains the same map. "Current" means the latest final $t$, and "historic" means any earlier one. Because the ordering keeps every prefix, a past global state is as well defined as the present one. $\mathcal{G}_t$ needs no root of its own, since a checkpoint of $\mathcal{O}$ at $t$ names $\mathsf{Read}(t)$, and thereby names $\mathcal{G}_t$.

**Directories.** A reader finds heads through **directories**, which spare it from replaying the ordering.

**Definition 3.2 (Directory).** A **directory** is a state $D$ whose records are pairs $(e, c)$, not both $\bot$:

- $e$ is a **repo entry**, a head together with the position that locates it in the update log, or $\bot$;
- $c$ is the root $\mathsf{Com}(D')$ of a **subdirectory** $D'$, or $\bot$.

Its root is $\mathsf{Com}(D)$. Directories **nest**: following subdirectory roots down from one directory yields a tree of directories. A **path** is a sequence of keys followed down that tree, and $D(k_1, \ldots, k_j)$ is the repo entry at its end. A directory holds no empty subdirectory.

A key can carry both kinds of entry, so that a name may be at once a repo and a prefix of other repos' names.

The **publisher directory** $D_{P,t}$ at $t$ has a repo entry for each repo $\rho = (P, s)$ with $H_t(\rho) \neq \bot$:

$$
D_{P,t}(s) = \big(\mathit{pos}_t(\rho),\ H_t(\rho)\big)
$$

Its root is $\mathsf{dir}_{P,t} = \mathsf{Com}(D_{P,t})$, and it names a Merkle DAG containing every head of $P$, which runs on to each repo's commit, its state, and its records.

There is no directory of every publisher. A read names its publisher (Definition 3.6), and a reader that wants many publishers finds them through an app's citations (§2), or through a lens over the update log (§3.5).

**Why these trees.** A party that chooses a tree's keys can choose its shape, and with it the cost of reading the tree (§6). A publisher chooses its repo names, and nobody else's, so a bad shape costs only that publisher's readers. A directory of every publisher would have its keys chosen by everyone who publishes, which is why there is none.

**Nesting within a publisher.** A publisher may name its repos by paths, $s = (s_1, \ldots, s_d)$, in which case its directory nests one level for each component: $D_{P,t}(s_1)$ has a subdirectory holding the names that begin with $s_1$, and so on down. Everything below a publisher is still chosen by that publisher, so the argument above continues to hold. Names are compared component by component, lexicographically, so that the repos below a prefix $(s_1, \ldots, s_j)$ form an interval of names, and a selector can name a folder of repos (Definition 3.6).

- **Cost.** Each level adds one tree to a repo's path, so finding one repo entry costs $h + 1$ nodes per level, and at most $(d + 1)(h + 1)$ for depth $d$. **[no proof]** An interval spanning many subdirectories opens each of them, by Lemma 6.2 applied to each, but no bound for the whole interval is given here.
- **Scope.** Nesting changes how directories are committed, not the map from paths to repo entries, so realizations that prove repo entries without committing to directories, such as the storage proofs of §5, are unaffected.

We write $D_{P,t}(s)$ for the repo entry at path $s$, whether or not the publisher nests.

**Lemma 3.3 (Directories only grow) [proof].** For $t \le t'$ and every repo $\rho$, $\mathit{pos}_t(\rho) \le \mathit{pos}_{t'}(\rho)$. Two authenticated entries for $\rho$ with the same position are equal.

_Proof._ A position changes only on a valid update of $\rho$, which increments it and appends one head to $\rho$'s history. By Assumption O, every honest party sees the same ordering, so the history at $t'$ extends that at $t$, and each position holds the same head in both. $\square$

Two readers that hold directory entries from different sources can therefore merge them by keeping, for each repo, the entry with the higher position.

**The update log.** Whereas a directory says what is current, the log says what happened, and when. The **update log** $\mathcal{U}_t$ has an entry for each valid update in $\mathsf{Read}_\iota(t)$, in order, each a tuple $(P, s, i, h, t_u)$, wherein $P$ and $s$ name the repo, $i$ is the position the update sets, $h$ is the new head, and $t_u$ is the clock value of the update's entry in $\mathcal{O}$. Its root is $\mathsf{log}_t = \mathsf{LCom}(\mathcal{U}_t)$, and the publisher directories are a fold of it: $D_{P,t}(s)$ is the $(i, h)$ of the last entry for $(P, s)$.

**Lemma 3.4 (The log locates every head) [proof].** For each repo $\rho$ and each $1 \le i \le \mathit{pos}_t(\rho)$, $\mathcal{U}_t$ has exactly one entry for $(\rho, i)$, and the entries for $\rho$ appear in increasing order of position. Clock values do not decrease along the log.

_Proof._ Each valid update of $\rho$ sets the next position (Theorem 3), and appears once in $\mathcal{U}$, in the order of $\mathcal{O}$. Clock values do not decrease along $\mathcal{O}$ (Assumption O). $\square$

**Proposition 3.5 (Citations are checkable) [proof].** Let a citation name $(\rho, i, h, k)$, and let $\ell = \mathsf{log}_t$ for a final $t$. A reader takes from any source an index $j$, an entry $(\rho, i, h', t_u)$ and an opening $\pi$, requires $\mathsf{Verify}(\ell, j, (\rho, i, h', t_u), \pi) = 1$, and calls the citation **true** if $h' = h$ and **false** otherwise. It then fetches the commit named $h$, and opens its state on $[k, k]$. Except with probability $\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}} + \mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$, a true citation yields exactly $M_h(k)$, which is the record at $k$ of $\rho$ at position $i$, and a false one names a head that $\rho$ never had at position $i$. If $i > \mathit{pos}_t(\rho)$, no source can supply the entry, and the read fails.

_Proof._ By position binding, the entry accepted is the log's true entry at $j$. By Lemma 3.4 it is the only entry for $(\rho, i)$, so $h'$ is the head of $\rho$ at position $i$, and $h = h'$ exactly when the citation names it. By Theorem 1 and opening binding, the opening yields $M_h(k)$. $\square$

**Cost.** One log opening, at most $2\lfloor \log_2 M \rfloor$ names (Lemma 6.3), one commit, $O(h+1)$ nodes of the state (Lemma 6.2), and one record. A citation is a fact about history, so later updates of $\rho$ never make it false. A reader that wants to know whether a newer version exists compares $i$ with $\mathit{pos}_t(\rho)$, from one directory entry. A false citation is the curator's error, and every reader can see it, and skip it.

**Cost of the registry.** A valid update changes one entry in each directory on its repo's path, and appends one entry to $\mathcal{U}$. A full reader maintains those directories' roots by rewriting at most $2(h+1)$ nodes of each tree (Lemma 6.1), where $h$ is the tree's height. Appending to the log costs fewer than two hashes on average, and at most $\lfloor \log_2 M \rfloor$, for a log of $M$ entries (Lemma 6.3). Nothing here is computed per record.

### 3.3 Reading a slice

A reader rarely wants all of a global state; more often, they want a slice.

**Definition 3.6 (Selector, slice).** A **selector** $S$ is a finite union of boxes $[P, P] \times I_s \times I_k$, each of one publisher, an interval of repo names and an interval of record keys. The **slice** by $S$ at $t$ is the union, over the boxes of $S$, of $\mathcal{G}_t$ restricted to the box, and we write it $\mathcal{G}_t|_S$, and $\mathcal{G}_{t'}|_S$ likewise for the state as of $t' \le t$.

- TODO: Investigate sets instead of intervals

Examples:

- **one record:** $[P, P] \times [s, s] \times [k, k]$;
- **one repo:** the same box, with every key;
- **one publisher's data:** $[P, P]$, with every repo name and every key;
- **an app:** the slice of its curator's repo, followed by the records its citations name, each checked as Proposition 3.5 describes.

Selectors are built from intervals for two reasons: openings are defined on intervals (Definition 1.6), and a tree opens an interval at a cost proportional to the interval's size (Lemma 6.2). A slice by anything else, such as a record's type or the value of a field, is not a selector but a slice of a lens's view (§3.4), which is maintained so that reading it costs the same as reading an interval.

**Full and light readers.** A **full** reader holds $\mathsf{Read}(t)$ and maintains the directories itself as it replays the valid entries. A **light** reader holds only roots, and needs one thing more from the ordering service.

**Definition 3.7 (Authenticated directories and log).** Let a light reader hold a checkpoint $d$ of $\mathcal{O}$ at a final $t$ (§1.5), and nothing else. It has two queries. Each asks an untrusted server for an answer and a proof, checks the proof against $d$, and returns the answer, or $\mathsf{fail}$ if the check fails:

1. $\mathsf{Dir}(d, B)$, for a **box** $B = [P, P] \times I_s$, returns $\{\, (P, s) \mapsto D_{P,t}(s) : s \in I_s \,\}$, which lists every repo in $B$ that has a head, with its repo entry, and no other repo.
2. $\mathsf{Log}(d)$ returns $\mathsf{st}(\mathcal{U}_t)$, the append state of the update log (Definition 1.7). From it the reader computes the log's length and its root. It checks openings of the log against that root, to read history and check citations, and appends to the state, to follow changes.

The ordering service **authenticates directories and the log** if no efficient adversary answering the queries can make one of them return a value, other than $\mathsf{fail}$, that differs from the true value at $t$, except with probability $\mathbf{Adv}^{\mathsf{dir}}$. An answer that omits a repo, adds one, or gives a wrong position differs from the true value.

The answers are values of the registry $R_t$ (Definition 3.1), or commitments to them. What the definition requires is that a reader holding only $d$ can check them. The cost depends on the realization, and §5 gives one. For a full reader, $\mathbf{Adv}^{\mathsf{dir}} = 0$, and the cost is a lookup in its own copy.

**Reading a slice.** A reader reads $\mathcal{G}_t|_S$ with $\mathsf{ReadSlice}$, wherein line 6 opens the state root on $I_k$, and $D'$ maps each key of the repo in $I_k$ to the name of its record.

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{ReadSlice}(d, S) \qquad (d \text{ a checkpoint at a final } t;\ S \text{ a selector}) \\
\hline
1: & Z \gets \emptyset \\
2: & \textbf{for each } \text{box } [P, P] \times I_s \times I_k \text{ of } S\textbf{ do} \\
3: & \quad E \gets \mathsf{Dir}(d, [P, P] \times I_s) \\
4: & \quad \textbf{for each } (P, s) \in \mathrm{dom}(E)\textbf{ do} \qquad \rhd\ \text{in parallel} \\
5: & \quad\quad h \gets \text{the head of } E(P, s);\ (e, \mathit{parent}, \mathit{root}) \gets \mathsf{Get}(h) \\
6: & \quad\quad (D', \pi) \gets \text{an opening of } \mathit{root} \text{ on } I_k\text{, from any source};\ \textbf{require } \mathsf{Check}(\mathit{root}, I_k, D', \pi) = 1 \\
7: & \quad\quad \textbf{for each } k \mapsto n \in D'\textbf{: } Z((P, s), k) \gets \mathsf{Get}(n) \\
8: & \textbf{return } Z \qquad \rhd\ \text{a map from } ((P, s), k) \text{ to records} \\
\hline
\end{array}
$$

The repos of a box are read in parallel, as are the fetches within a line. Line 5 fails only if no source serves the value named $h$, and since every head in a directory is the name of a commit (Definition 3.1), there is nothing else to check. Theorem 4 shows that the result is exactly $\mathcal{G}_t|_S$, with nothing added and nothing left out.

**Cost.** Let the box hold $r$ repos and $m$ records, and let $h$ bound the trees' heights. Line 3 costs what §5 states, while lines 5 to 7 fetch:

- $r$ commits;
- at most $r(h+1) + m/(2^b - 1)$ tree nodes in expectation, and $r(h+1) + mh$ in the worst case (Lemma 6.2);
- $m$ records.

Nothing depends on the size of the rest of the global state. If a host serves each opening as one bundle, the read takes four round trips, for lines 3, 5, 6, and 7, whatever the slice's size, with every repo read in parallel.

**History.** The **history** of a repo is the sequence of its entries in the update log, which is the sequence of heads of Theorem 3. It is also the chain of parents its commits name, because the guard of an update requires its commit's parent to be the head (Definition 3.1). A reader that wants it by position or by time takes it from the log. With $M$ the length of the log, it can read history at an authenticated $t$ in four ways:

- **One position.** To learn the head of $\rho$ at position $i$, the reader takes an index $j$ from any source, and checks an opening of $\mathsf{log}_t$ at $j$ to an entry for $(\rho, i)$, as for a citation (Proposition 3.5). Cost: one opening, at most $2\lfloor \log_2 M \rfloor$ names (Lemma 6.3).
- **As of an earlier $t' \le t$.** $H_{t'}(\rho)$ is the head of the last entry for $\rho$ in $\mathcal{U}$ whose clock value is at most $t'$. The reader runs $\mathsf{ReadAt}$, below. Cost: the directory entry, two openings, and no old state of the ordering.
- **A slice at an earlier $t'$.** The reader reads the directory at $t$ for the box, which lists every repo that had a head at $t'$, and possibly more. It then runs $\mathsf{ReadAt}$ for each repo, and lines 5 to 7 of $\mathsf{ReadSlice}$ for the heads it returns. Cost: the directory at $t$, plus two openings per repo, plus those lines (Corollary 4.1).
- **A whole history** of $p$ positions takes $p$ openings, or $O(p \log M)$ names. Openings that share a tree share names, but no tighter bound is given here.

Each of these reads is an instance of one search. The update entries of a repo $\rho$, each $(P, s, i, h, t_u)$ with index $i$ and value $h$, form its **track**. By Lemma 3.4, a track's entries carry the indices $1, \ldots, n$ in order, where $n = \mathit{pos}_t(\rho)$, and their clock values do not decrease. $\mathsf{LastAt}$ finds the last entry of a track with clock value at most $t'$. The source at line 2 is asked for that entry, or for the track's first entry if there is none, and if it gives any other, line 3 or line 4 fails.

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

$\mathsf{ReadAt}(d, \rho, t')$, for $\rho = (P, s)$ and a checkpoint $d$ at a final $t \ge t'$, takes $\ell$ from $\mathsf{Log}(d)$, and $n$ from the repo entry of $\rho$ in $\mathsf{Dir}(d, [P, P] \times [s, s])$, or $n = 0$ if $\rho$ is not in it, and returns $\mathsf{LastAt}(\ell, n, \sigma, t')$, a head or $\bot$, for $\sigma$ the track of $\rho$.

**Proposition 3.8 (History reads are sound) [proof].** Given the true log root and track length at $t$, $\mathsf{LastAt}(\ell, n, \sigma, t')$ returns the value of the last entry of $\sigma$ with clock value at most $t'$, or $\bot$ if there is none, or $\mathsf{fail}$, except with probability $2\,\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$. It is **complete**: an honest source makes it return that value, not $\mathsf{fail}$. So $\mathsf{ReadAt}(d, \rho, t')$ returns $H_{t'}(\rho)$, with $\bot$ if there was no head at $t'$, or $\mathsf{fail}$, except with probability $2\,\mathbf{Adv}^{\mathsf{dir}} + 2\,\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$, and it is complete.

_Proof._ By position binding, each entry accepted at lines 2 and 4 is the log's true entry at its index. By Lemma 3.4, the track's entries carry the indices $1, \ldots, n$ in order, with clock values that do not decrease. If line 3 returns, the track's first entry is later than $t'$, so every entry is, and $\bot$ is right. Otherwise $t_u \le t'$, and the next entry of the track, if there is one, is later than $t'$ (line 4). So entry $i$ is the last with clock value at most $t'$. For completeness, the log holds an entry for every index from $1$ to $n$ (Lemma 3.4). The honest source opens the last entry at or before $t'$, or the first entry if there is none, and the next entry if $i < n$. Every check then passes. For $\mathsf{ReadAt}$, $\mathsf{Log}$ and $\mathsf{Dir}$ give the true root and track length, except with $\mathbf{Adv}^{\mathsf{dir}}$ each. If $\rho$ has no head at $t$, it had none at $t' \le t$ (Lemma 3.3). Otherwise the last entry of its track at or before $t'$ carries the head as of $t'$, because the directories are a fold of the log. $\square$

**Change.** A reader that follows a box keeps a cursor, consisting of the box, the append state $\mathit{st}$ of the update log (which is $O(\log M)$ names), and the box's directory entries $E$. A first $\mathsf{ReadSlice}$, together with $\mathsf{Log}$, gives the cursor at $t$, and to move to $t' > t$, the reader runs $\mathsf{Follow}$:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{Follow}(d', \mathit{cur}) \qquad (\mathit{cur} = (B, I_k, \mathit{st}, E);\ d' \text{ a checkpoint at a final } t') \\
\hline
1: & \ell' \gets \mathsf{Root}(\mathsf{Log}(d'));\ M \gets \text{the length } \mathit{st} \text{ fixes};\ (l_{M+1}, \ldots, l_{M'}) \gets \text{from any source} \\
2: & \textbf{for } j = M + 1, \ldots, M'\textbf{: } \mathit{st} \gets \mathsf{Append}(\mathit{st}, l_j) \\
3: & \textbf{require } \mathsf{Root}(\mathit{st}) = \ell' \qquad \rhd\ \text{every entry of the log since } M\text{, in order} \\
4: & \mathit{old} \gets \emptyset \\
5: & \textbf{for } j = M + 1, \ldots, M'\textbf{: if } l_j \text{ is an entry for } (P, s) \in B\textbf{ then}\textbf{ if } (P, s) \notin \mathrm{dom}(\mathit{old})\textbf{ then } \mathit{old}(P, s) \gets E(P, s);\quad E(P, s) \gets \text{the repo entry } l_j \text{ sets} \\
6: & \textbf{for each } (P, s) \in \mathrm{dom}(\mathit{old})\textbf{: } \Delta(P, s) \gets \mathsf{Diff}\big(\mathit{old}(P, s),\ E(P, s),\ I_k\big) \\
7: & \textbf{return } \big((B, I_k, \mathit{st}, E),\ \Delta\big) \\
\hline
\end{array}
$$

$\mathsf{Diff}(e, e', I)$ returns the keys in $I$ whose records differ between the state of $e$ and the state of $e'$, where an absent entry gives the empty state. It fetches the commits of the heads in $e$ and $e'$, and walks their two state trees together from the roots, skipping every pair of subtrees with equal names, and every subtree outside $I$. The log holds the updates of every publisher, of which $\mathsf{Follow}$ passes over those outside $B$.

**Cost.** Let the log have $\Delta_\mathcal{U}$ entries between $t$ and $t'$, let $c'$ repos of the box have a new head, and let $\Delta$ count the keys of the box whose record changes.

- lines 1 to 3 fetch $\Delta_\mathcal{U}$ entries, and hash at most $2\Delta_\mathcal{U} + \lfloor \log_2 M \rfloor + 1$ times (Lemma 6.3);
- line 5 is $O(\Delta_\mathcal{U})$ lookups;
- line 6 fetches at most $2c'$ commits, $O((\Delta + c')(h+1))$ nodes, and $\Delta$ records.

For line 6: in each repo, the walk fetches only nodes that differ between the two trees and whose gaps meet $I_k$. Those whose closed gap holds a changed key in $I_k$ number at most $2(h+1)$ per key (Lemma 6.1). Any other such node has a gap that meets $I_k$ and holds a changed key outside it, so it contains an end of $I_k$, and there are at most two of these per level and tree, counted by $c'$.

None of these costs depends on the size of the slice, but only on how much of it changes, and on $\Delta_\mathcal{U}$.

**Following an app.** An app is followed as its curator's repo. A change of a citation, to a new position or a new record, costs one check of Proposition 3.5, and a citation that did not change costs nothing, since what it names is fixed.

**Ceiling.** A light reader that follows one publisher, and checks everything itself, fetches the whole update log, whose entries are those of every publisher, at about 80 bytes an entry **[estimate]**. It can instead accept an indexer's sub-log of that publisher, which costs only its own entries (§3.5).

### 3.4 Lenses

A slice gives a reader the data as it was committed, yet most uses want something derived from it: the records of one type, an index by some field, a count, or the data without the repos a curator excludes. A lens is the general form of such a derivation.

**Overview of §3.4 and §3.5.** The definitions below are easier to follow with the whole picture in view. Consider an app for sharing recipes, whose publishers are cooks and food sites, wherein each recipe is a record with a field $\mathit{cuisine}$. A reader wants every Thai recipe in the app, from every publisher. Computing that list from the slice is easy; the questions are who computes it, and why a reader should believe them.

- **A lens is a named query.** A selector says what goes in, and a fixed function says what comes out. Our example is the **cuisine index**, whose selector is every recipe the app cites, and whose function re-keys each recipe $x$ by its cuisine, as $(\mathit{cuisine}, x)$. Every Thai recipe then sits under keys beginning with `thai`, and one opening reads them all. It is the index lens on the field $\mathit{cuisine}$, among the examples below.
- **A view is the result.** It is itself a state, a key-value map with a root, and so it can be sliced, opened against its root, and used as the input of another lens.
- **A view is a fact, not an opinion.** The input is the authenticated global state, and the function is fixed and named, so everyone who computes the view at $t$ obtains the same root (Proposition 3.10), and there is nothing to vote on.
- **An indexer computes and serves views.** Recomputing a view costs reading its whole slice, so most readers let an indexer do it. The indexer follows the global state, keeps the view current, and signs a **claim**: "the view of this lens at $t$ has root $R$". A reader then reads the view like any other state, with openings against $R$, and pays only for the part it reads.

What stops an indexer from signing the wrong $R$ is that anyone can recompute it, and that two honest indexers agree exactly (Proposition 3.10), so a reader that asks two of them, or recomputes the part it reads, catches a wrong root. For the lenses that matter most, a wrong root is also cheap to prove wrong, with a **fraud proof** of one opening and one point read (Appendix C), provided the lens is **pointwise**: in the cuisine index, each recipe $x$ contributes at most one entry to the view, at the key $(\mathit{cuisine}, x)$, and that entry depends on that recipe alone.

The same property keeps views cheap to maintain. When a record changes, only its own entry in a pointwise view changes, by deleting the old entry and inserting the new one (Proposition 3.12). Filters, indexes, curation, embeddings, and per-publisher sub-logs are all pointwise. Counts and sums are not, but they can be updated in step with each change, while joins and general code are neither, and this paper gives no succinct fraud proof for them (§7).

| Term              | What it is                                                         | Familiar analogue                             |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| selector $S$      | which data goes in                                                 | a `FROM … WHERE` clause                       |
| lens $L = (S, f)$ | a named, deterministic query                                       | a view definition in SQL                      |
| view $V_L(t)$     | the result at $t$, a state with a root                             | a materialized view                           |
| claim             | an indexer's signed "$V_L(t)$ has root $R$"                        | an AppView's answer, but signed and checkable |
| watcher           | anyone who recomputes the view (Appendix C)                        | an auditor                                    |
| fraud proof       | $(y,\ $opening of $R$ at $y,\ x,\ $point read at $x)$ (Appendix C) | a counterexample                              |

An indexer here thus plays the role of an AT Protocol AppView or labeller, but with no authority: its input is public, and its function is named in its claims, so anyone can compute the same answer.

**Definition 3.9 (Lens).** A **lens** is a pair $L = (S, f)$ of a selector $S$ and a deterministic function $f$ from slices to states. Its **view** at $t$ is the state

$$
V_L(t) = f\big(\mathcal{G}_t|_S\big)
$$

with root $\mathsf{Com}(V_L(t))$. The function $f$ is given as code, and the lens is named $N(\texttt{lens}, L)$.

A view is a state, so everything defined for states applies to it: it has a root, it can be sliced by its own keys, it can be the input of another lens, and a publisher can commit it as a repo.

A selector may span publishers, and a lens may also take an app's citations as its input, in which case $f$ is applied to the records they name, each checked by Proposition 3.5. A view of an app is thus a view of what its curator cites, and it is exactly as trustworthy as the curator's choices: the records themselves are checked, and the choosing is the curator's own.

**Proposition 3.10 (Views are determined) [proof].** For every lens $L$ and final $t$, every honest party that computes $V_L(t)$ gets the same root, except with the probability bounded in Theorem 4.

_Proof._ By Theorem 4, every honest party obtains $\mathcal{G}_t|_S$. $f$ is deterministic, and by unique representation $\mathsf{Com}(V_L(t))$ depends only on $V_L(t)$. $\square$

A claim that "the view of $L$ at $t$ has root $r$" therefore contains its own check, since anyone can recompute the view from public data. A lens has no producer; many lenses can read the same global state, and none of them is privileged. A host that serves a view is merely a cache, and anyone who recomputes it detects a wrong one.

Computing a view from nothing costs reading its slice, plus running $f$, which is unavoidable once. What matters is the cost of keeping a view current, and that depends on the form of $f$.

**Definition 3.11 (Pointwise lens).** A lens is **pointwise** if there are functions $\tau$ and $g$ such that:

- $\tau(x, r)$ is a key of the view, and is injective in $x$: $\tau(x, r) = \tau(x', r')$ implies $x = x'$;
- $g(r)$ is a record, or $\bot$;
- the view of every slice $Z$ is

$$
f(Z) = \big\{\, \tau(x, r) \mapsto g(r) \;:\; (x \mapsto r) \in Z,\ g(r) \neq \bot \,\big\}
$$

Here $x$ ranges over the keys of the slice, which are tuples $(P, s, k)$.

**Proposition 3.12 (Pointwise update) [proof].** Let $L$ be pointwise, and let slices $Z$ and $Z'$ differ on a set $X$ of keys. Then $f(Z')$ is obtained from $f(Z)$ in two passes:

1. for each $x \in X$ with $Z(x)$ defined and $g(Z(x)) \neq \bot$, delete the key $\tau(x, Z(x))$;
2. for each $x \in X$ with $Z'(x)$ defined and $g(Z'(x)) \neq \bot$, insert $\tau(x, Z'(x)) \mapsto g(Z'(x))$.

_Proof._ By injectivity, every entry of the view comes from exactly one key of the slice. Entries that come from keys outside $X$ are the same in both views. An entry deleted in pass 1 and one inserted in pass 2 for a different key of $X$ have different view keys, by injectivity, so pass 1 never removes what pass 2 adds. $\square$

**Cost.** $|X|$ deletions and $|X|$ insertions, each rewriting at most $2(h+1)$ nodes of the view's tree (Lemma 6.1). Together with $\mathsf{Follow}$ (§3.3), whose $\Delta$ is at least $|X|$, a pointwise view follows its slice at a cost of $O((\Delta + c')(h+1))$ node reads and writes, for $c'$ as defined there. This does not depend on the size of the slice or the view.

Examples, with the cost of keeping each one current:

- **Filter.** Keep the records of type $\theta$. Take $\tau(x, r) = x$, and $g(r) = r$ if $r$ has type $\theta$, otherwise $\bot$. It is pointwise.
- **Validation.** Keep the records that satisfy a deterministic predicate $\varphi$ on one record, such as conformance to a schema. Take $\tau(x, r) = x$, and $g(r) = r$ if $\varphi(r)$, otherwise $\bot$. It is pointwise and key-revealing, so a view that presents a record failing $\varphi$, or omits one that passes, has a fraud proof (Proposition C.2). This validates at read time, as anyone may, whatever an app cites, and a failing record stays in the committed state. A rule over several records, such as uniqueness of a field or a reference that must resolve, is an aggregate or a join, and has no succinct fraud proof here (§7).
- **Curation.** Drop the repos in a set $\mathcal{X}$, taking $\tau(x, r) = x$, and $g(r) = r$ unless $x$ lies in a repo in $\mathcal{X}$. For a fixed $\mathcal{X}$, it is pointwise. If $\mathcal{X}$ is itself read from the global state, for example from a curator's repo, adding a repo to $\mathcal{X}$ removes that repo's records from the view at a cost proportional to their number, which is exactly how much the view changes. Any reader or indexer can thereby apply a curator's choices, or its own, to data that nobody curated.
- **Index.** Re-key by a field $a$. Take $\tau(x, r) = (r.a, x)$ and $g(r) = r$. It is pointwise. Every record whose field $a$ equals $v$ is then the slice of the view on the keys that begin with $v$, which is one opening: $O(h + j)$ nodes for $j$ matches (Lemma 6.2). This is how a reader slices by the value of a field.
- **Order statistics.** The $j$ records with the largest value of $a$ are the last $j$ keys of the index on $a$, at a cost of $O(h + j)$. They need no lens of their own.
- **Aggregate.** A count, or a sum in any group, as a state with one key. It is not pointwise, but it is incremental: add $g$ of what pass 2 inserts, and subtract $g$ of what pass 1 deletes. The cost is $O(|X|)$. Minimum and maximum have no inverse, so they are read as order statistics instead.
- **Embedding.** Map each record to a vector under a fixed model $E$: $\tau(x, r) = x$ and $g(r) = E(r) \in \mathbb{R}^d$. $E$ is code plus weights, and is named in the lens. It is pointwise and key-revealing (§3.5).
  - **Cost.** Keeping the view current costs one evaluation of $E$, plus $O(h+1)$ node rewrites, per changed record.
  - **[assumption] Determinism.** Proposition 3.10 and the fraud proofs of Appendix C require $E$ to give the same output, bit for bit, for every party, which floating-point inference on different hardware does not. $E$ must therefore be a reference implementation in integer or fixed-point arithmetic, with quantized output, for example 8-bit integers. With an approximate $E$, honest indexers compute different roots, and the cross-checking of §3.5 ceases to work.
- **Join.** Records of two slices with equal values of a field $a$, keyed by $(v, x, y)$. Keep an index on $a$ for each side, and when $x$ changes on one side, open the other side's index at $v$. **[no proof]** The update costs $O(|X| (h + j))$ for $j$ matches per value, and the view is correct, though neither claim is proven here. Since the view itself can be as large as the product of the two sides, the cost is stated in terms of the output.
- **General $f$.** It must be recomputed, at $O(|\mathcal{G}_t|_S|)$ reads plus the cost of $f$. A lens on which other lenses depend should therefore be built from pointwise lenses and aggregates, so that every view on top of it stays proportional to change.

**Trusting a view.** A reader can hold a view in one of three ways:

1. **recompute it** from the slice, trusting nothing beyond Theorem 4. This costs the slice once, then the change after that, for pointwise lenses and aggregates;
2. **accept it from a host**, trusting the host, but keeping the ability to check it later by recomputing. This costs the part of the view it reads. Appendix C makes the host accountable;
3. **check a proof** that its root is $\mathsf{Com}(f(\mathcal{G}_t|_S))$, against the directories. This costs the view plus verifying the proof (§7).

A publisher that commits a view as a repo makes it authenticated data from that publisher (Theorem 2), and the claim that it is the view of $L$ can still be checked in the first way.

### 3.5 Indexers

A view has to be computed by someone, and served. An **indexer** is a party that follows the global state, maintains views, and serves them to readers. It plays the role of an AT Protocol AppView, feed generator, or labeller, with two differences:

- **It has no authority.** Its input, namely the global state and the update log, is public and authenticated, so anyone can recompute what it serves.
- **Completeness is checkable.** What AT Protocol must trust a relay for, namely that it saw every event, is here the on-chain update log.

An indexer is a host of views, and the only way it can lie is by serving a wrong view, which anyone who recomputes it, or asks another indexer, detects. Appendix C makes that lie cheap to prove.

**Lenses over logs.** A lens may also read the update log, as the map $j \mapsto \ell_j$ for $j \le M$, where $M$ is the log's length at some final $t$. The **sub-log lens** re-keys the update log by publisher:

$$
\tau(j, \ell) = (\ell.P,\ j), \qquad g(\ell) = \ell
$$

where $\ell.P$ is the update's author. The lens is pointwise (Definition 3.11), and since its view is committed with $\mathsf{Com}$, the entries of one publisher form an interval. The slice of the view on publisher $P$ is $P$'s **sub-log**: every update of $P$, in order, each with its index in the update log.

**Discovery.** The update log names every repo that has a head, and when each changed. It is therefore the input of every index of what exists: the publishers active since some $t$, the repos of a publisher, or the apps, which are the repos that hold a manifest (§2). Each of these is a lens over the log, and an index of what those repos hold, such as the repos with records of some type, reads each repo the log names. Citations are records like any other, so the apps that cite a repo, or the repos a validator passed, are an index lens over citations. A reader thereby finds repos and apps it cannot name, trusting an indexer only as far as it chooses (below), rather than as it would trust a search engine.

**Definition 3.13 (Claim).** A **claim** is a value $c = (\iota,\ N(\texttt{lens}, L),\ t,\ R)$ signed by an indexer, for the registry $\iota$ whose ordering $t$ refers to. It asserts that $R = \mathsf{Com}(V_L(t))$. For a lens over a log, $t$ is replaced by the length $M$ of the log it reads.

**Following one publisher.** A reader that follows $P$ does three things:

1. it takes a claim for the sub-log lens at length $M'$;
2. it proves the length $M$ of the update log from the chain (§5), to learn how far behind the claim is;
3. it reads the slice of $R$ on the keys $(P, j)$ with $j$ beyond its cursor.

This costs one slot proof, one signature, and $O(h + \Delta_P)$ nodes for $\Delta_P$ new entries (Lemma 6.2), independent of every other publisher. The reader can also check any entry against the update log, at $O(\log M)$ each, which catches forged entries but not omitted ones; omissions are caught by cross-checking, and proven by fraud proofs (Appendix C).

**Trusting an indexer.** A reader can trust an indexer at one of five levels, from cheapest to strongest:

1. **Trust it.** This is the AT Protocol model.
2. **Hold it to account.** Wrong claims are cheap to prove (Appendix C), which requires one honest watcher that sees the reader's root.
3. **Cross-check $k$ independent indexers.** The view is correct unless all $k$ are wrong in the same way, and no watcher is needed.
4. **Check a proof of the view** (§3.4).
5. **Recompute the view** from the input.

An indexer can still lag, which the reader detects by comparing $M'$ with $M$, and it can refuse to serve, in which case the reader moves to another indexer or recomputes. Indexers are not privileged: any number can serve the same lens from the same public input, and any two of them that agree have the same root.

**Search over a bundle.** The simplest search index is the embedding view itself. A host serves it as a **bundle**: the view's entries, split into shards by key interval, each shard an opening of the view's root on its interval (Definition 1.6), so that a reader checks each shard against a claim's root as it arrives. The reader fetches every shard, scores each vector against its query, and keeps the $j$ best. The result is exact, and, unlike that of the tree below, complete: an opening binds every key of its interval, so a host can neither forge an entry nor omit one (Definition 1.6), and the claim's root can be cross-checked or recomputed (above). The query never leaves the reader, and every reader of the view fetches the same shards, so the hosts learn which views a reader searched, but nothing of what it searched for. **[estimate]** A view of $10^5$ records with 256-dimensional 8-bit vectors is about 26 MB, which a reader fetches once, and then follows by change (Proposition 3.12). A bundle suits a view up to the size a reader is willing to hold. Past that, the reader fetches part of the view, through a tree.

**Search indexes.** For a view too large to fetch whole, finding the records whose embeddings best match a query should not require fetching every vector. The structure below makes this possible, while keeping it checkable.

For a query $q \in \mathbb{R}^d$ with $\Vert q \Vert \le 1$, the score of a vector $v$ is $\langle q, v \rangle$.

**Definition 3.14 (Bounded tree).** A **bounded tree** over an embedding view $V$ is a Merkle DAG with two kinds of node:

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

**Lemma 3.15 (Sound bounds prune exactly) [proof].** If a node with centre $\mu$ and radius $\varepsilon$ is sound, then every leaf $v$ below it has $\langle q, v \rangle \le \langle q, \mu \rangle + \varepsilon$. Consequently, on a sound tree, $\mathsf{Search}(\alpha, q, j)$ returns $j$ leaves of highest score, or every leaf if there are fewer.

_Proof._ $\langle q, v \rangle = \langle q, \mu \rangle + \langle q, v - \mu \rangle \le \langle q, \mu \rangle + \Vert q \Vert\, \Vert v - \mu \Vert \le \langle q, \mu \rangle + \varepsilon$, by Cauchy–Schwarz, $\Vert q \Vert \le 1$, and soundness. Every leaf not yet reached lies below a node in $Q$, so its score is at most that node's bound, which is at most $\beta(n)$ for the node $n$ of line 3. When line 4 returns, that is below every score in $T$. $\square$

Quantization, and any other approximation, is absorbed into $\varepsilon$ and needs no separate argument.

**Not a view.** A bounded tree need not be a function of $V$: any centres and radii are allowed, and two honest indexers may build different trees. A tree is checked instead by its soundness, which is a local property: a false bound or a forged leaf has a short proof (Appendix C), while an omitted entry has none given here (§7). A sound tree gives no false negatives among its leaves.

**Cost of a bounded tree:**

- **Inserting a leaf:** descend from the root, enlarging the radius of each node on the way down, for $O(\mathit{depth})$ node rewrites, each $O(d)$.
- **Deleting a leaf** keeps every node sound, because soundness quantifies only over the leaves present. Bounds grow looser as leaves are deleted, and an occasional rebuild, at $O(|V|)$, tightens them again.
- **Shape.** The indexer chooses the tree's shape. A deep or loose tree is slow to search, but it is not fraud, and readers choose between indexers by the results they get.
- **[no proof] Search.** How many nodes a search visits depends on how tight the bounds are near the query, and may be every node. No bound on the expected number is given here.

**Searching on the reader's side.** An indexer can serve search in one of three ways:

- **Serving the bundle,** in which case the reader ranks every record itself, and the hosts learn nothing about the query.
- **Serving the tree,** in which case the reader runs the search of Lemma 3.15 itself, and the query never leaves its device. Nodes are named by $N$, so any host can serve them, not only the indexer.
- **Answering queries,** in which case the indexer sees every query, and learns what each reader searches for.

Serving the bundle is the default for a view small enough to fetch whole, serving the tree for a larger one, and answering queries is a downgrade a reader chooses. With the tree served, the hosts see which nodes a reader fetches, which reveals roughly where the query lies, near the centres of the nodes it expanded. **[open]** A reader can blur this by always fetching a fixed number of nodes per query, and by spreading its fetches across hosts, but how much that hides is not analysed here.

### 3.6 Costs

$h$ is a tree's height and $2^b$ its expected fanout, and every node has at most $B_{\max}$ entries (§6). For keys whose names are random, $h \approx \log_{2^b} n$ for $n$ entries. A party that chooses keys can raise $h$ to $\ell$ by trying about $2^{b\ell}$ candidates, though $h \le 2\lambda / b$ always.

| Operation                                                                                                             | Cost                                                                                                                                                 | Status                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Maintain directories, per valid update                                                                                | $\le 2(h+1)$ node rewrites per tree                                                                                                                  | Lemma 6.1 [proof]                                                |
| Read a slice of $r$ repos and $m$ records                                                                             | directory (§5), plus $r$ commits, $r(h+1) + m/(2^b-1)$ nodes in expectation, $m$ records; 4 round trips                                              | Lemma 6.2 [proof; expectation for random names]                  |
| Append to the log of $M$ entries, per valid update                                                                    | fewer than 2 hashes on average, at most $\lfloor \log_2 M \rfloor$                                                                                   | Lemma 6.3 [proof]                                                |
| Head of a repo at a position, or as of an earlier $t'$                                                                | 1 or 2 openings, each at most $2\lfloor \log_2 M \rfloor$ names; no old state                                                                        | Proposition 3.8, Lemma 6.3 [proof]                               |
| Read a slice as of an earlier $t'$                                                                                    | a current read, plus 2 openings per repo                                                                                                             | Corollary 4.1 [proof]                                            |
| Check a citation                                                                                                      | 1 log opening, at most $2\lfloor \log_2 M \rfloor$ names; 1 commit; $O(h+1)$ nodes; 1 record                                                         | Proposition 3.5 [proof]                                          |
| Follow a slice from $t$ to $t'$, with $\Delta_\mathcal{U}$ log entries, $c'$ repos changed, and $\Delta$ keys changed | $\Delta_\mathcal{U}$ log entries and $O(\Delta_\mathcal{U} + \log M)$ hashes, plus $2c'$ commits, $O((\Delta + c')(h+1))$ nodes and $\Delta$ records | Definition 1.7, Lemmas 6.1, 6.2 and 6.3 [proof]                  |
| Follow a pointwise view                                                                                               | following its slice, plus $O(\lvert X \rvert (h+1))$ node rewrites, $\lvert X \rvert \le \Delta$                                                     | Proposition 3.12, Lemma 6.1 [proof]                              |
| Read by field value, through an index                                                                                 | $O(h + j)$ nodes for $j$ matches                                                                                                                     | Lemma 6.2 [proof]                                                |
| Follow an aggregate in a group                                                                                        | $O(\lvert X \rvert)$                                                                                                                                 | [proof: one line, above]                                         |
| Follow a join                                                                                                         | $O(\lvert X \rvert (h + j))$                                                                                                                         | **[no proof]**                                                   |
| Follow one publisher through an indexer                                                                               | 1 slot proof, 1 signature, $O(h + \Delta_P)$ nodes                                                                                                   | Lemma 6.2 [proof]; trust as in §3.5                              |
| Follow an embedding view                                                                                              | one evaluation of $E$, plus $O(h+1)$ node rewrites, per changed record                                                                               | Definition 3.11, Lemma 6.1 [proof]; determinism [assumption]     |
| Insert into a bounded tree, or delete from it                                                                         | $O(\mathit{depth} \cdot d)$ to insert; deleting needs no change of bounds                                                                            | Definition 3.14 [proof]                                          |
| Search a bounded tree                                                                                                 | between $O(\mathit{depth})$ nodes and every node, depending on the bounds                                                                            | Lemma 3.15 [proof of exactness]; **[no proof]** of expected cost |
| Check a fraud proof against a bounded tree                                                                            | one node per level, plus one distance or one point read                                                                                              | Appendix C [proof]                                               |
| Check a fraud proof against a pointwise, key-revealing lens                                                           | 1 map opening plus 1 point read: over a log, $O(h + \log M)$ names                                                                                   | Proposition C.2 [proof, given opening binding]                   |
| Any other lens                                                                                                        | the whole slice, plus the cost of $f$                                                                                                                | —                                                                |

## 4. Security of data and history

**Theorem 1 (Binding) [proof].** No efficient adversary controlling every host can make an honest reader accept, for head $h$, any state other than the one committed by $h$, except with probability $\mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{bind}}_{\mathsf{Com}}$.

_Proof._ Every node is accepted only if its name matches, so substituting a node finds a collision in $N$. The reader recomputes $\mathsf{root}$ over the records it received, so two different states accepted for one root break binding of $\mathsf{Com}$. $\square$

**Theorem 2 (Authenticity) [proof].** Under Assumption O, except with negligible probability, every head in the history of repo $(P, s)$ was set by an entry authored by $P$.

_Proof._ Heads change only through valid updates. An update moves the head of $(P, s)$ only when its author is $P$ (line 1 of $\mathsf{Apply}$), and an accepted entry with author $P$ that $P$ did not make contradicts authorship. $\square$

**Theorem 3 (Linear history) [proof].** Under Assumption O, for every repo, the valid updates form one sequence. The $i$-th sets the head at position $i$ to the name of a commit whose parent is the head at position $i - 1$. No head occurs twice, except with probability $\mathbf{Adv}^{\mathsf{bind}}_N$.

_Proof._ The ordering is total. By its guard (Definition 3.1), an update is valid only if its commit's parent is the current head at its place in the order, and line 2 sets the head to that commit's name. Induct on $\mathcal{O}$. Write $h_0 = \bot$, and suppose $h_i = h_j$ with $i > j \ge 1$, for the least such $j$. The commits named $h_i$ and $h_j$ are $(e_i, h_{i-1}, \mathit{root}_i)$ and $(e_j, h_{j-1}, \mathit{root}_j)$. If they differ, they are a collision of $N$. Otherwise $h_{i-1} = h_{j-1}$. If $j = 1$, that says $h_{i-1} = \bot$, but every head at a position of at least $1$ is a name. Otherwise it contradicts the choice of $j$. $\square$

Because the registry computes each head from its commit's fields, the order of Theorem 3 and the chain of parents that the commits name are one and the same history.

**Theorem 4 (Slice soundness) [proof, given opening binding].** Let $t$ be final, and $S$ a selector with $q$ boxes. No efficient adversary controlling every host and server can make $\mathsf{ReadSlice}(d, S)$ return any map other than $\mathcal{G}_t|_S$, except with probability at most $q\,\mathbf{Adv}^{\mathsf{dir}} + \mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$.

_Proof._ Fix a box $[P, P] \times I_s \times I_k$.

1. **Line 3** yields the true restriction of $P$'s directory, except with $\mathbf{Adv}^{\mathsf{dir}}$. So $E$ holds exactly the repos of the box that have a head, with their true heads.
2. **Lines 5 and 6.** $\mathsf{Get}$ accepts the commit only if it matches its name $h$, so it is the commit whose name the registry computed (Definition 3.1). By correctness, $M_h|_{I_k}$ has an accepting opening against the commit's state root. If the reader accepts any other map, then two different maps have accepted openings for the same root and interval, which breaks opening binding.
3. **Line 7.** $\mathsf{Get}$ accepts each record only if it matches its name.

Apart from the $q$ directory failures, any substitution is a collision in $N$, or two accepted openings. $\square$

**Corollary 4.1 (Historic slices) [proof, given opening binding].** Let $t$ be final, $t' \le t$, and $S$ a selector with $q$ boxes and $r$ repos. For each box, let the reader run line 3 of $\mathsf{ReadSlice}$ and $\mathsf{Log}(d)$; for each repo listed, $\mathsf{LastAt}$ with that log root and the repo's position; and for each head $h \neq \bot$ returned, lines 5 to 7 of $\mathsf{ReadSlice}$. No efficient adversary controlling every host and server can make the result differ from $\mathcal{G}_{t'}|_S$, except with probability at most $2q\,\mathbf{Adv}^{\mathsf{dir}} + 2r\,\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}} + \mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{open}}_{\mathsf{Com}}$.

_Proof._ Step 1 of Theorem 4 applies to line 3, and $\mathsf{Log}$ adds one more query per box. By Lemma 3.3, every repo with a head at $t'$ has one at $t$, so the directory at $t$ lists every repo of the box on which $\mathcal{G}_{t'}$ can be defined. For each, Proposition 3.8 shows that $\mathsf{LastAt}$ gives the head of $\rho$ as of $t'$, or $\bot$ if there is none, except with $2\mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$. Steps 2 and 3 of Theorem 4 then apply to that head. $\square$

**Corollary 4.2 (Reading an app) [proof, given opening binding].** Let a reader read an app's repo with $\mathsf{ReadSlice}$, and check each citation it holds by Proposition 3.5. Then, except with the probabilities of Theorem 4 and Proposition 3.5, it obtains exactly the citations the curator committed at $t$, and for each true one, exactly the record it names, as its publisher committed it.

_Proof._ Theorem 4 for the curator's repo, then Proposition 3.5 for each citation. $\square$

An app can therefore choose what to present, but not alter it, and a reader learns which of its citations are false. What a curator chooses, and why, is its own affair.

Theorem 4 holds for any $\mathsf{Com}$ with opening binding, and for the tree of §6, opening binding is Lemma 6.2.

Theorem 4 gives completeness as well as inclusion. A host can refuse to serve part of a slice, in which case the reader knows the slice is incomplete, but it cannot make the reader accept a partial slice as the whole. This is precisely what a light reader loses without authenticated directories: it can still prove the head of a repo it can name, but the repos it cannot name are exactly those a host can withhold.

# Part II — Instantiation

## 5. The ordering service as a blockchain

A public blockchain is an ordering service: its blocks are the sequence, its block timestamps the logical clock, and $\mathsf{Verify}$ its validity rule, whether proof of work or the signatures of its validators. Assumption O then holds under the chain's own consensus assumptions:

- agreement, with $\delta$ the chain's finality delay for the kind of reader in question (below);
- authorship, from its signature scheme;
- a clock, from block timestamps, which consensus keeps non-decreasing and within a bounded skew of real time. Epochs are then measured in time, and do not move when block times change. Skew shifts the window of Definition 3.1 by at most its bound, and can only cause an update to fail, which costs liveness. The bound is assumed, not derived.

**Finality.** What $\delta$ is depends on how a reader checks headers. A full node that derives the chain itself sees an entry as final once the chain's own finality covers it, which on a rollup means once its batch is final on the base chain, typically within an hour. A light reader that checks a rollup's state roots without trusting its proposer must instead wait until they are settled: about seven days, the challenge window, on an optimistic rollup, and the time to prove one on a ZK rollup. Its latest final header is then old state, and storage proofs against it require a node that keeps archive state, which most nodes do not. A light reader on an optimistic rollup therefore either uses such a node, or trusts the proposer's latest root and takes the shorter $\delta$, which adds that trust to $\mathbf{Adv}^{\mathsf{dir}}$.

The registry (Definition 3.1) is run by the chain, as a program whose transition is $\mathsf{Apply}$. It keeps $\mathcal{H}$ in its storage, and only a commitment for $\mathcal{U}$ (below). It rejects an invalid entry rather than recording it, which comes to the same thing, since $\mathsf{Apply}$ leaves the state unchanged on one. The program decides nothing that $\mathsf{Apply}$ does not, and anyone holding the chain could compute the same state. Its identifier $\iota$ is the chain's identifier together with the program's address. On an EVM chain, an entry is a transaction, whose destination $d$ is the pair of its chain identifier and its `to` address, and whose operation $\mathit{op}$ is its calldata. The transaction signature covers all three, the chain identifier under EIP-155, so it is a signature on $(d, \mathit{op})$, as Assumption O.2 requires. A statement is signed as EIP-712 typed data, with $\iota$ as the `chainId` and `verifyingContract` of its domain. For an update, the program computes $h' = N(e, \mathit{parent}, \mathit{root})$ itself, as the name of the commit in its canonical encoding (§6), so that every head it stores names a commit. **[estimate]** With a fixed encoding template and the chain's SHA-256 precompile, this costs a few hundred gas. It rejects a late update with an error of its own, so that a publisher's tooling can commit again under the current epoch and resubmit.

**Curators.** A curator is an author like any other. It may be a key, or a program on the chain that submits updates to its repo when a rule of its own is met, such as signatures from a threshold of moderators, or a verdict from a validator it names. Nothing in the registry tells the two apart. A deployment may also keep a naming program that maps short app names to curator repos and payout addresses, for discovery and for referral [WP2, §2.4]; it is a convenience outside the registry, and decides nothing about data.

**Directories.** A chain authenticates directories (Definition 3.7) by storage proofs. **[assumption]** They rest on the chain's light-client protocol, wherein a light reader verifies block headers and proves values of the program's state against a header's state commitment. That protocol is taken to satisfy Assumption O for a light reader, and is not specified here (§7).

The chain's commitment to its state proves any slot the reader names, but cannot list the slots that belong to a publisher. The program therefore keeps, for each publisher, a list of its repos, appended on first write, alongside each repo's head and position. A light reader proves, against the header at $t$, for a box, the publisher's list of repos, filtered by $I_s$, and the head and position of each repo that remains.

**Cost.** A constant number of slot proofs per repo of the publisher, and none per record. **[estimate]** Each slot proof is a path in the chain's state trie of a few kilobytes, and proofs against one header share their upper nodes. An update of an existing repo writes four slots that already exist (its head, its position, one peak of the update log, and the log's length, below), for about 20k gas. The first update of a repo also creates its head and position slots, an element of its publisher's repo list (more than one if the name is long), and that list's length. A new slot costs about 22k gas, so a first write costs on the order of 100k.

**Ceiling.** The lists are in the order in which repos were created, not in key order, so a reader that wants a narrow $I_s$ within a publisher that has many repos pays for all of that publisher's repos. Storage proofs need no prover.

**Logs.** For the update log, the program keeps the length $M$ of the log, and the peaks of a Merkle mountain range over it (§6), in one slot per peak height. Each valid update appends the leaf for $(P, s, i, h', t_u)$ to the update log, where $t_u$ is the block timestamp. On chain, $\mathsf{LCom}$ uses keccak-256 in place of $N$, over $\texttt{abi.encode}$ of a fixed schema for the entry, and keeps the tags $\texttt{leaf}$, $\texttt{node}$, and $\texttt{mmr}$. Since Definition 1.7 needs only binding, Lemma 6.3 holds with keccak-256 for $N$. $\texttt{abi.encodePacked}$ is not injective, and must not be used.

- **Cost.** Two storage writes per log entry, one peak and $M$, plus fewer than one storage read and two hashes on average, and at most $\lfloor \log_2 M \rfloor$ of each (Lemma 6.3). **[estimate]** A write to an existing peak slot costs about 5k gas, and a write to a new height about 22k, which happens at most $\lfloor \log_2 M \rfloor + 1$ times in a log's life.
- **Reading.** A light reader proves $M$ and the live peak slots against one header, at most $\lfloor \log_2 M \rfloor + 1$ slots given by the set bits of $M$, and computes the log's root itself.
- **Why no root is stored.** Storing it would cost every update another write, and a hash over every peak, to save each reader at most $\log_2 M$ slot proofs. Writes are paid on every update, whereas reads are paid only by readers.

With the log, a light reader reads histories and earlier slices against the header of its latest final $t$ (Proposition 3.8), and needs no state older than that, although on an optimistic rollup that header is itself about a week old (above). A reader can still prove against an earlier header if some node serves old state; that node can refuse, but it cannot lie.

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

_Proof._ Take the keys of level at least $\ell$ in order. Each has level above $\ell$ independently, with probability $2^{-b}$. A level-$\ell$ node's entries are a maximal run of keys of level exactly $\ell$, so its length is geometric. $\square$

**Shape.** Names are random only if the party that chooses the keys does not search for them. A party that does choose keys can do two things:

- **raise the height:** it places a key at level $\ell$ by trying about $2^{b\ell}$ candidates. The height never exceeds $2\lambda / b$, because a name has $2\lambda$ bits.
- **fill a node:** it chooses keys of level 0, which costs nothing, since a fraction $1 - 2^{-b}$ of all keys have level 0. With the bound $B_{\max}$, however, such a tree is malformed rather than slow.

A party that chooses all of a tree's keys can thus make the tree costly to read, or even unreadable, but only for its own readers. This is why every tree in the protocol has its keys chosen by a single party: a publisher chooses its record keys and repo names, and a curator, being a publisher, chooses the keys of its citations. There is no directory of every publisher (§3.2), whose keys everyone would choose.

**Lemma 6.1 (Locality) [proof].** Let maps $D$ and $D'$ differ on a set $K$ of $\Delta$ keys, and let $h$ be the larger of their heights. Then at most $2\Delta(h+1)$ nodes of each tree are absent from the other.

_Proof._ Fix a level $\ell$. Take a level-$\ell$ node of $D$'s tree, with gap $(a, b)$, such that no key of $K$ lies in the closed interval $[a, b]$. Levels depend only on keys, so $a$ and $b$ are still consecutive keys of level above $\ell$ in $D'$, and $D'$ agrees with $D$ on $(a, b)$. So $D'$'s tree has the same node. A key of $K$ lies in the closed gap of at most two level-$\ell$ nodes: one if it is inside a gap, two if it is an end. So at most $2\Delta$ level-$\ell$ nodes are absent from the other tree. Sum over the $h + 1$ levels, and argue symmetrically for $D'$. $\square$

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

_Counting._ At level $\ell$, the gaps that meet $I$ are separated by keys in $I$ of level above $\ell$, so there are at most one more than the number of such keys. Summing over levels gives $h + 1$, plus each key in $I$ counted once for every level below its own. For random names, $\mathbb{E}[\mathsf{level}(k)] = \sum_{j \ge 1} 2^{-bj} = 1/(2^b - 1)$.

_Binding._ Given the root, each node that $\mathsf{Check}$ reaches is fixed by its name, except with $\mathbf{Adv}^{\mathsf{bind}}_N$. Define the map a root commits to, $D_{\mathit{root}}(k)$, as what $\mathsf{Check}$ accepts on $[k, k]$, for any root, whoever built it. We show that every accepted opening on $I$ is $D_{\mathit{root}}|_I$, by induction over the nodes $\mathsf{Check}$ reaches. Each reached node passes the well-formedness checks, so its keys are sorted inside its gap, and a successful check below a node returns only keys inside that node's gap. For a key $k \in I$, the walk on $[k, k]$ follows exactly the child whose gap contains $k$. That gap meets $I$, so the walk on $I$ follows it too, and by induction both return the same value at $k$. Every other child the walk on $I$ follows returns no value at $k$, because $k$ is outside its gap. So the two openings agree at every key of $I$, and two accepted openings on one interval are equal. Correctness holds for the tree built from a sorted map: $\mathsf{Check}$ accepts every interval, with the map's restriction, so $D_{\mathsf{Com}(D)} = D$. A tree that fails the checks on some interval is **malformed**, and a read of it fails.

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

_Proof._

1. The root fixes $M$, and so the shape and every peak. Each peak is the root of a binary tree whose shape $M$ fixes. Two different logs of length $M$ differ at some leaf, and the paths from it to the root give two different inputs to $N$ with one output. Position binding is the same argument along one path. The tags $\texttt{leaf}$, $\texttt{node}$ and $\texttt{mmr}$ keep a leaf from being read as a node.
2. Peaks correspond to the set bits of $M$.
3. The sibling path has length $e \le \lfloor \log_2 M \rfloor$, and there are at most $\lfloor \log_2 M \rfloor$ other peaks.
4. Each merge removes one peak, and each append adds one. The number of peaks never falls below 1, and starts at most $\lfloor \log_2 M \rfloor + 1$. So $\Delta$ appends make at most $\Delta + \lfloor \log_2 M \rfloor$ merges. An append to a log of $M - 1$ entries merges once for each trailing one bit of $M - 1$, which is at most $\lfloor \log_2 M \rfloor$.

$\square$

## 7. Scope

**Missing proofs.** The following claims are stated without a full proof:

- **Embedding models (§3.4).** They are assumed to be deterministic to the bit.
- **Commit epochs (§3.2).** An honest publisher's update is valid only if the ordering includes it within $W$ epochs of making the commit. That delay is assumed, not analysed. A late update fails, and its publisher commits again.
- **Bounded trees (§3.5).** There is no succinct proof that an entry was omitted, no bound on the expected cost of a search, and no analysis of what the pattern of fetched nodes reveals about a query.
- **Nested directories (Definition 3.2).** No bound is given for opening an interval of names that spans many subdirectories, beyond Lemma 6.2 applied to each one.
- **Whole histories (§3.3).** No bound tighter than $p$ independent openings is given for openings that share a tree.
- **The join lens (§3.4).** Neither its correctness nor its cost is proven.
- **Expected costs (Lemma 6.0, Lemma 6.2, §3.6).** They assume that names are random, and that keys are not searched for. Worst-case bounds are given alongside.
- **§5.** Storage-proof sizes and gas costs are estimates. The light-client protocol is assumed, not analysed. A trustless light reader on an optimistic rollup has $\delta$ of about seven days, and needs a node that serves archive state.
- **Appendix C.** Fraud proofs for lenses that are not pointwise and key-revealing are not given, and the conditions under which a watcher's proof reaches a reader are argued, not proven.

This document omits the following, each of which builds upon it:

- how a light reader verifies block headers;
- proofs that a view is correct (§3.4), for lenses too large to recompute;
- validators' evidence: proofs that a state satisfies a rule, including rules relating its records, incrementally from a state already validated, and validators that attest to their code;
- curators that are programs (§5): moderation sets, and the rules by which they update;
- sealed (encrypted) data, and who may read it, with payment shared with the app that referred it, which [WP2] gives;
- for micro-commits between anchors (Appendix B): forced inclusion, delegated device keys, sealing finer than an epoch, and the on-chain cost of checking faults.

**Operators.** The protocol decides what is committed, and nothing about content. Hosts, indexers, curators, and the key-release schemes of [WP2, §4.3] each apply a policy of their own: a host drops what it will not serve, an indexer serves what it will, a curator cites what it will, and a release scheme refuses keys. Each of these is visible, or detectable: a citation withdrawn is an update, a view's lens is named in its claim, a refusal is a grant without a release, and data that no host serves makes a read fail rather than lie. What an operator's policy must be, and its obligations at law, are outside this document.

# Appendix A — Agents and a semantic CDN

This appendix sketches how a software agent uses the protocol: how it finds, among every view on the network, the ones that can answer a question, and how it reads them, through a single server and without trusting any index. It is a design built on Part I, not part of the protocol. Its results are tagged as in §1.1.

### A.1 One server for every app

An agent connects to one server, and through it to every app. The server does three things:

1. **It lists apps.** It finds them through a lens over the update log that selects the repos holding a manifest (§3.5), and reads each app's **manifest** (§2): what the app is for, the validators it relies on, and the views it serves, each named by its lens $N(\texttt{lens}, L)$, with recent claims for it (Definition 3.13). A manifest is a record of the app's own repo, so the agent reads it as it reads any record, and its history is public.
2. **It mounts views.** It fetches a view's nodes from any host, and checks them against a claim's root.
3. **It offers the same tools for every view:** describe what a view holds, search it by meaning, get one record, find records similar to one, count the values of a field, and browse without a query.

One server suffices because every view is a state of the same kind (§3.4): a map from keys to records, some of which carry vectors under a named model. The tools that read one view read every view, so an app needs no code of its own, and no page or browser, to be usable by an agent. It publishes data and claims, and the agent does the rest.

What remains is to choose which views to mount. A network may hold millions of views, and an agent can neither mount them all nor trust a search engine to choose for it. The rest of this appendix answers that question.

### A.2 The semantic CDN

A content delivery network serves data from wherever it is cached, by name. Every node in Fangorn is named by its content (§1.3), so any host can already serve as such a network, and a reader checks what it receives. What such a network cannot do is say _which_ names to ask for. A **semantic CDN** adds that: it routes a query to the data closest to it in meaning, and then delivers that data by name, while the routing, like the data, can be checked rather than trusted.

It rests on two structures, a clustered view and its coverage, and one algorithm.

**Definition A.1 (Clustered view).** Let $E$ be an embedding model (§3.4), and $C = (\mu_1, \ldots, \mu_m)$ a sequence of **centres** in $\mathbb{R}^d$. For a selector $S$, the **clustered view** is the lens $L = (S, f)$, with $E$ and $C$ named in it, given by

$$
\tau(x, r) = (\kappa(r),\ x), \qquad g(r) = E(r), \qquad \kappa(r) = \min \{\, i : \Vert E(r) - \mu_i \Vert \le \Vert E(r) - \mu_{i'} \Vert \text{ for all } i' \,\}
$$

so that each record is filed, with its vector, under its nearest centre, and ties go to the lowest index. Its **cluster** $i$ is the set of its entries whose keys begin with $i$.

The lens is pointwise and key-revealing (Definitions 3.11 and C.1), since $x$ is part of each key, so it inherits everything Part I gives such lenses. In particular:

- **A cluster is one opening.** Its keys form an interval, so one opening of the view's root returns the whole cluster, with proof that no entry was added or left out (Definition 1.6). This is what the bounded tree lacks: a tree ordered by geometry cannot prove that an entry is absent (Appendix C), whereas a clustered view, being ordered by key, can.
- **A wrong view has a fraud proof.** A record filed under the wrong cluster, given a wrong vector, or omitted is refuted by one opening and one point read (Proposition C.2), given the determinism of $E$ that §3.4 assumes. Computing $\kappa$ in the fixed-point arithmetic of $E$ makes it deterministic as well.
- **It follows by change.** A changed record moves at most one entry (Proposition 3.12).

The centres are part of the lens, so changing them makes a new lens with a new name. A view is reclustered when its centres no longer fit its data, and that, like any recomputation, costs reading its slice once.

**Definition A.2 (Coverage).** A **coverage** of a clustered view is a signed value

$$
\mathsf{cov} = \big(\iota,\ N(\texttt{lens}, L),\ t,\ R,\ (\varepsilon_1, \ldots, \varepsilon_m)\big)
$$

which is a claim (Definition 3.13) that $R$ is the root of the view at $t$, together with a **radius** $\varepsilon_i$ for each cluster. The coverage is **sound** if every vector $v$ in cluster $i$ has $\Vert v - \mu_i \Vert \le \varepsilon_i$. For a query $q$ with $\Vert q \Vert \le 1$, the **bound** of cluster $i$ is $\beta_i(q) = \langle q, \mu_i \rangle + \varepsilon_i$.

A coverage is small: $m$ centres and radii, a few kilobytes for $m = 8$ and $d = 256$ at one byte per coordinate, whatever the size of the view.

**Proposition A.3 (Coverages are checkable) [proof].** If a coverage is not sound, a single opening of $R$ at one entry proves it. If it is sound, then for every $v$ in cluster $i$, $\langle q, v \rangle \le \beta_i(q)$.

_Proof._ If some $v$ in cluster $i$ has $\Vert v - \mu_i \Vert > \varepsilon_i$, the opening of $R$ at its key shows $v$, and the key shows $i$. Anyone checks the distance, as for a false bound in a bounded tree (Appendix C). The second claim is Lemma 3.15 applied to the cluster. $\square$

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

_Proof._ By opening binding, line 5 yields exactly cluster $i$ of $V$, every entry and no other. Every entry not yet seen lies in a cluster still in $Q$, and by Proposition A.3 its score is at most that cluster's bound, which is at most $\beta$ at line 3. When line 4 returns, every unseen entry therefore scores below every entry of $T$. A cluster is opened only if line 4 did not return, that is, only if its bound is at least the current $j$-th best score, which never decreases. $\square$

**Recursion.** The coverages are themselves data. The **directory** of a semantic CDN is a view whose entries are the clusters of the views it lists, each keyed by $(N(\texttt{lens}, L), i)$, with value $(\mu_i, \varepsilon_i)$ and the coverage it comes from. It is a lens over manifests and claims, and like any view it can be clustered in turn. Let an upper centre $\nu$ gather lower clusters $i$ with centres $\mu_i$ and radii $\varepsilon_i$, and give it the radius

$$
\delta = \max_i \big( \Vert \mu_i - \nu \Vert + \varepsilon_i \big)
$$

By the triangle inequality, every vector of every gathered cluster lies within $\delta$ of $\nu$, so the upper level is sound whenever the lower ones are, and $\mathsf{Route}$ runs unchanged over it, opening an upper cluster to obtain lower ones. A false $\delta$ has a fraud proof of one upper entry. The network's search index is thus one tree of clustered views, whose upper levels hold views and whose lower levels hold records. Each level is a view that anyone may compute, serve, or refute, and nobody holds anyone's rows.

Nor is there one directory. Each is a lens over public manifests, and whoever builds one chooses which views it lists, as a curation. Agents choose among directories as readers choose among indexers (§3.5). A directory may list every view that some app cites, or every repo that some validator passed.

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

An agent is also an author, and so may publish: its notes, its findings, or a model of what its user likes, as repos of its own. Views of them are cartridges that the agent itself can mount on another device, or under another model, and that others can mount if it shares them. Such data can be validated and cited, as any other can. An agent's memory is thereby held by its owner's key, rather than by the platform that runs the agent.

### A.4 What is open

- **A shared model.** Routing compares scores across views, so every view in one semantic CDN must use the same model $E$, bit for bit (§3.4). Views under different models form separate networks, or need a mapping between models, which is not given here.
- **Choosing centres.** How centres should be chosen, how often a view should be reclustered, and how tight radii can be kept as data changes, are not analysed. These affect cost, not correctness.
- **Counts.** A coverage could also state each cluster's size, which an agent would use to estimate fetch costs. A size is an aggregate, checked by anyone who reads the cluster, but it has no succinct fraud proof.
- **What hosts learn.** Which clusters an agent opens reveals roughly what it asked. How much a fixed fetch pattern hides is not analysed.
- **Paid and sealed views.** [WP2] gives sealed data. A public view of sealed data covers only its public fields [WP2, §2.3].

# Appendix B — Between anchors: repos that change faster than the ordering

Every head costs one entry in the ordering (§3.2), and every entry costs a transaction (§5). A repo can therefore change no faster than the ordering accepts entries, and each change costs as much as any other. That suits a council's minutes. It does not suit a sensor that reads every 100 ms, or a computation over a live stream.

This appendix lets a publisher commit off the ordering, at any rate, and **anchor** periodically. Between anchors, each change is a **micro-commit** that the publisher signs. A micro-commit gives what a Merkle clock gives (§3.1): authorship, and order within the repo. It does not give currency, meaning that no newer state exists; the next anchor supplies that. If the publisher anchors a history that contradicts what it signed, a short proof shows it. It is a design on Part I, not part of the protocol, and its results are tagged as in §1.1.

No merge is needed. A repo still has one writer (§1.5), so its micro-commits form a chain, exactly as its commits do. Each repo is, in effect, its own sequencer, and the ordering is where its history settles.

### B.1 Micro-commits

**Definition B.1 (Micro-commit).** Let repo $\rho = (P, s)$ have position $i$ at the time of writing, so that its head $h_i$ is fixed by the update log (Lemma 3.4). A **micro-commit on base $i$** is a value

$$
\mu = (\iota,\ \rho,\ i,\ j,\ a,\ \mathit{root},\ \tau)
$$

together with $P$'s signature on it, where:

- $j \ge 1$ is its index;
- $a = \mathsf{LCom}(\mu_1, \ldots, \mu_{j-1})$ is the log commitment of the micro-commits before it on the same base, the empty log's commitment if $j = 1$;
- $\mathit{root}$ is the root of the state after it;
- $\tau$ is the publisher's own time, which is informational and trusted by no one.

The **sub-log** on base $i$ is the sequence $L_i = (\mu_1, \ldots, \mu_k)$ of micro-commits that $P$ has signed on that base. The **soft head** at $\mu_j$ is the triple $(i, j, N(\mu_j))$, and its state is the one committed by its $\mathit{root}$.

A micro-commit is a commit that is never submitted. It is linked to its predecessors by a log commitment rather than a parent, so that proving one is in a sub-log costs a positional opening, logarithmic in $k$, rather than a walk back through every predecessor (Definition 1.7). Naming $\iota$, $\rho$, and $i$ binds the signature to one registry, one repo, and one base, as every value signed apart from the ordering is bound (§3.2), so it cannot be replayed elsewhere.

### B.2 Anchors

**Definition B.2 (Anchor).** An **anchor** of $\rho$ is an update whose commit is

$$
\gamma = (e,\ h_i,\ \mathit{root},\ a)
$$

where $a = \mathsf{LCom}(\mu_1, \ldots, \mu_k)$ commits a sub-log on base $i$ with $k \ge 1$, and $\mathit{root}$ is the root of $\mu_k$. Its name is $N(e, h_i, \mathit{root}, a)$. A commit with no sub-log is the case $a = \bot$, encoded as in §3.1, so an ordinary update is unchanged.

The registry needs one change. An update carries $a$, and line 2 of $\mathsf{Apply}$ computes $h' = N(e, \mathit{parent}, \mathit{root})$ when $a = \bot$, and $h' = N(e, \mathit{parent}, \mathit{root}, a)$ otherwise. The guard is unchanged: the anchor's parent is the on-chain head $h_i$, and not any micro-commit. The registry never sees a micro-commit and checks nothing about one, just as it never fetches a commit or a state (§3.2).

Theorem 3 holds unchanged, since its proof uses only that a head names a commit whose fields include its parent. Theorem 1 holds as well, now for $a$: a head fixes its commit, and so fixes the sub-log commitment it carries.

What the registry does not enforce is the publisher's obligation: **an anchor on base $i$ commits exactly the micro-commits that $P$ signed on base $i$, and ends at the state of the last one.** That obligation is enforced instead by the faults below.

### B.3 Pre-confirmation, and its faults

**Definition B.3 (Faults).** A **fault** of $P$ on base $i$ of $\rho$ is one of:

- **(F1) Double signing.** Two micro-commits on base $i$ with the same index $j$, both signed by $P$, that differ.
- **(F2) Omission or substitution.** A micro-commit $\mu$ on base $i$ with index $j$, signed by $P$, while the update at position $i + 1$ commits a sub-log of length $k < j$, or one whose opening at position $j$ is a value other than $\mu$. An ordinary update, with $a = \bot$, counts as a sub-log of length $0$.
- **(F3) Wrong root.** The update at position $i + 1$ has a root other than that of the micro-commit at position $k$ of its sub-log.

The evidence for F1 is the two signed values. The evidence for F2 and F3 is the signed micro-commit (for F2), the anchor's commit, fetched by its name, and one positional opening of $a$.

**Proposition B.4 (Pre-confirmations bind) [proof].** Let $P$ sign a micro-commit $\mu$ at index $j$ on base $i$ of $\rho$, and let the update at position $i + 1$ be final. Then, except with probability $\mathbf{Adv}^{\mathsf{bind}}_N + \mathbf{Adv}^{\mathsf{pos}}_{\mathsf{LCom}}$, either that update commits a sub-log whose position $j$ opens to $\mu$, or a fault F2 exists and can be checked with one positional opening. Two readers who hold micro-commits signed by $P$ at the same index on the same base hold the same value, or between them hold a fault F1.

_Proof._ By Theorem 3, position $i + 1$ holds one head, the name of one commit, which by binding of $N$ fixes $a$. By binding of $\mathsf{LCom}$, $a$ fixes its length $k$. If $k < j$, that is F2. Otherwise, by position binding, exactly one value opens at position $j$, and if it is not $\mu$, that is F2. The second claim is the definition of F1. $\square$

Proposition B.4 is what makes data that has not yet been anchored sellable. A buyer who holds $\mu_j$ knows that $P$ said it, in this order, after $h_i$. Once an anchor lands and is final, the buyer either finds $\mu_j$ at index $j$ of the history at position $i + 1$, or holds a proof that $P$ broke its word.

What a soft head does not give is exactly what a Merkle clock does not give (§3.1):

- **currency:** a newer micro-commit may exist;
- **liveness:** $P$ may never anchor;
- **availability:** no host is obliged to serve it.

The first two are recovered by anchoring, and §B.4 adds an incentive for the second.

**Reading.** A soft read replaces $H_t(\rho)$ with a soft head, and runs lines 5 and 6 of $\mathsf{ReadSlice}$ against its root. Theorem 1 and authenticity by signature still hold, but Theorem 4's currency for that repo does not. A citation names a position (§2), and so cites an anchored head. A curator may also cite a soft head $(\rho, i, j)$, which its readers trust as far as they trust the soft head, until the anchor.

**Views.** A pointwise view can follow soft heads, one micro-commit at a time, at the cost of Proposition 3.12. An indexer's claim about a view at a soft head names $(\rho, i, j)$, and it is refuted as any claim is, once the soft head is anchored or shown to be a fault.

### B.4 Accountability

A fault convinces anyone who checks it, so it needs no contract. For compensation, $P$ may post a **bond** to a contract that pays out to the first valid fault, as an indexer does (Appendix C).

- **F1** costs two signature checks on chain.
- **F2 and F3** cost the anchor's commit fields, from which the contract computes its name and checks it against the update log by a positional opening of $\mathcal{U}$, plus one opening of $a$. That is $O(\log M + \log k)$ hashes. **[estimate]** The gas is not given here.

**Forced inclusion [no proof].** A publisher can sign and never anchor, which is not a fault. A holder of $\mu$ may post it to the bond contract, which records its clock value $t_\mu$. If no update at position $i + 1$ that commits at least $j$ micro-commits is applied by $t_\mu + \Theta$, the bond pays. This is the analogue of a rollup's forced inclusion. $\Theta$ must allow at least the window $W$ of §3.2, and is otherwise not analysed.

### B.5 Cost and frequency

A micro-commit costs no entry. Making one costs a signature, an append to the sub-log (fewer than two hashes on average, Lemma 6.3), and rewriting the changed part of the state, $O(\Delta(h+1))$ nodes for $\Delta$ changed keys (Lemma 6.1). On chain, an anchor costs what an update costs (§5), plus one 32-byte field. **[estimate]** That is a few hundred more gas for the longer encoding. Anchoring every $\Theta$ seconds therefore costs a publisher in proportion to $1/\Theta$, **whatever its rate of change**, and a soft head becomes final within $\Theta + \delta$.

**Relayed anchors.** Assumption O.2 binds an entry to its author, which on an EVM chain is the transaction's sender. To let one transaction carry many publishers' anchors, an update must instead be authorized by $P$'s signature on the update as an EIP-712 statement, which anyone may submit. Theorem 2 then reads "set by an entry carrying $P$'s signature", and its proof is unchanged. **[estimate]** Each anchor in a batch adds one signature check, a few thousand gas, to its storage writes, so batching saves only the overhead of each transaction. The real lever is $\Theta$. A relayer can delay an anchor, which is the liveness that Assumption O leaves to the ordering, but it cannot forge or alter one.

### B.6 Streams for sale

A sealed repo is encrypted per epoch, and one witness for the repo opens it for that epoch [WP2, §2.2]. Micro-commits are states like any other, so a stream sealed this way is **sold by the epoch**: buying epoch $e$ buys the key to every micro-commit in it. Selling by the minute needs conditions whose statements name minutes, which [WP2, §2.1] allows, since a statement's epoch is whatever interval the condition names. Revocation takes effect after $W$ epochs [WP2, §2.2], so a stream should use short ones. **[no proof]** That this composes with soft heads is not analysed.

### B.7 Many devices, one publisher

A single writer per repo is what spares us from CRDTs, so a publisher with a fleet must give **each device its own repo**, for example $s = (\mathit{fleet}, \mathit{device})$, nested as in §3.2. Two devices writing one repo would race for the same base and both sign index $j$, which is a fault F1 against their own publisher.

If every device holds $P$'s key, compromising one device compromises all of them. The remedy is **delegated keys**: a program that $P$ controls lists, for each repo, the key allowed to sign its micro-commits and anchors, and it is read when an anchor or a fault is checked, as a curator that is a program reads its moderators (§5). That program is not specified here.

### B.8 What is open

- **Forced inclusion:** the choice of $\Theta$, and the contract's cost.
- **Delegated device keys:** the program and its revocation.
- **Sealing finer than an epoch,** and its interaction with soft heads.
- **The on-chain cost** of checking F2 and F3.
- **Citations of soft heads:** how a citation of a soft head is checked once it is anchored.

# Appendix C — Accountable indexers

Section 3.5 lets a reader check an indexer by recomputing a view, or by asking another indexer for it. This appendix lets anyone _prove_ an indexer wrong, for the lenses that matter most, with one opening and one point read and no arbiter. Nothing in Part I depends on it. Its results are tagged as in §1.1.

### C.1 Fraud proofs

A lens is pointwise (Definition 3.11) if each input record contributes at most one entry to the view, which depends on that record alone. A wrong view is then wrong at some particular key, and what the view should hold there depends on a single record.

**Point reads.** A **point read** of an input at a key $x$ returns the input's value at $x$, or $\bot$, together with what is needed to check it.

- **For a slice of the global state,** a point read at $x = (P, s, k)$ as of $t$, against a checkpoint at any final clock value from $t$ on, consists of $\mathsf{ReadAt}$ for the head of $(P, s)$ as of $t$, and lines 6 and 7 of $\mathsf{ReadSlice}$ on $[k, k]$. It returns $\mathcal{G}_t(P, s, k)$, by Proposition 3.8, binding of $N$, and opening binding, and a later update does not change it.
- **For a log,** it is a positional opening when $j \le M$, and $\bot$ when $j > M$, checked by position binding.

**Definition C.1 (Key-revealing lens).** A pointwise lens is **key-revealing** if $x$ can be computed from $\tau(x, r)$.

Filter, curation, index, and sub-log lenses are all key-revealing, since their view keys either are $x$ or contain it.

A **fraud proof** against a claim $c = (\iota, N(\texttt{lens}, L), t, R)$ is a tuple $\mathit{fp} = (y, V', \pi, x, p)$, consisting of a key $y$ of the view, an opening $(V', \pi)$ of $R$ on $[y, y]$, a key $x$ of the input, and a point read $p$ of the input at $x$. When the opening holds $y$, the key $x$ is ignored and recomputed from $y$. The proof is checked by $\mathsf{CheckFraud}$:

$$
\begin{array}{rl}
\hline
& \textbf{Algorithm } \mathsf{CheckFraud}(c, \mathit{fp}) \qquad (c = (\iota, N(\texttt{lens}, L), t, R);\ \mathit{fp} = (y, V', \pi, x, p)) \\
\hline
1: & \textbf{require } \mathsf{Check}(R, [y, y], V', \pi) = 1 \qquad \rhd\ V' \text{ is what } R \text{ holds at } y\text{: empty, or } \{y \mapsto v\} \\
2: & \textbf{if } V' \neq \emptyset\textbf{ then } x \gets \text{the key that } y \text{ reveals} \qquad \rhd\ \text{key-revealing (Definition C.1)} \\
3: & z \gets \text{the input's value at } x \text{, from the point read } p;\ \textbf{require } p \text{ checks as of } t \qquad \rhd\ z = \bot \text{ if absent at } t \\
4: & \textbf{if } z \neq \bot \wedge g(z) \neq \bot \wedge \tau(x, z) = y\textbf{ then } U \gets \{y \mapsto g(z)\}\textbf{ else } U \gets \emptyset \qquad \rhd\ \text{what the view holds at } y \\
5: & \textbf{return } (U \neq V') \qquad \rhd\ \text{true: the claim is wrong at } y \\
\hline
\end{array}
$$

**Proposition C.2 (Succinct fraud proofs) [proof, given opening binding].** Let $L$ be pointwise and key-revealing.

1. **Completeness:** if $R \neq \mathsf{Com}(V_L(t))$, and every head the lens reads commits to a well-formed state (§6), there is a fraud proof $\mathit{fp}$ with $\mathsf{CheckFraud}(c, \mathit{fp}) = \mathsf{true}$. It holds one opening of $R$ and one point read, and checking it evaluates $\tau$ and $g$ once.
2. **Soundness:** no efficient adversary outputs $\mathit{fp}$ with $\mathsf{CheckFraud}(c, \mathit{fp}) = \mathsf{true}$ when $R = \mathsf{Com}(V_L(t))$, except with the probability bounded by opening binding, binding of $N$ and Proposition 3.8. This holds for a claim at any $t$, however old, because the point read is taken as of $t$.

_Proof._ Let $V = V_L(t)$. By line 4, and the definition of a pointwise view, $U = V|_{[y, y]}$ whenever $z$ is the true input value at $x$ and $y = \tau(x, z)$ or $y \notin V$.

_Completeness._ The opening of $R$ at $[y, y]$ exists by correctness (Definition 1.6), and the point read at $x$ succeeds and returns the true value, by completeness of $\mathsf{ReadAt}$ (Proposition 3.8) and correctness of the state's opening. Let $V'' \neq V$ be the map $R$ commits to, and let $y$ be a key where they differ. If $y \in V$, then $y = \tau(x, r)$ for an input entry $x \mapsto r$. Take that $x$. If $V''$ holds $y$, line 2 recomputes the same $x$, because the lens is key-revealing. Either way $U = \{y \mapsto V(y)\} \neq V''|_{[y,y]} = V'$. If $y \notin V$, then $V''$ holds some $y \mapsto v$, and line 2 computes $x$ from $y$. If line 4 gave $U = \{y \mapsto v\}$, then $y$ would be in $V$ with value $v$. So $U \neq V'$.

_Soundness._ Let $R = \mathsf{Com}(V)$. By opening binding, $V' = V|_{[y, y]}$. By Proposition 3.8, binding of $N$ and opening binding, $z$ is the true value at $x$ as of $t$. If $y \in V$, then $x$ is the key $y$ reveals, by line 2, so $y = \tau(x, z)$ and $U = V|_{[y,y]}$. If $y \notin V$, then $U$ is empty, because otherwise $y$ would be in $V$. Either way $U = V'$, and $\mathsf{CheckFraud}$ returns $\mathsf{false}$. $\square$

To find $y$, someone must compute $V$, namely a **watcher** (below), and every other reader then pays two openings to check the proof.

Indexing networks such as The Graph [TG] ask an indexer to commit to the sequence of writes it made, its "proof of indexing". A mismatch between two indexers then shows only that they disagree, and a dispute goes to an arbitrator appointed by governance. A claim here, by contrast, commits to the view itself, so that a mismatch can be walked down to the key where the two disagree (Lemma 6.1), and $\mathsf{CheckFraud}$ decides which one is wrong, with no arbiter.

**Cost of a fraud proof:**

- **for a lens over a log:** one map opening, $O(h+1)$ nodes (Lemma 6.2), plus one log opening, at most $2\lfloor \log_2 M \rfloor$ names (Lemma 6.3);
- **for a lens over a slice:** the map opening, plus a point read as of $t$: two log openings for the head, and one opening of the state (Proposition 3.8, Lemma 6.2).

**Equivocation.** If an indexer signs two different roots for the same lens and the same $t$, the pair is itself evidence: by Proposition 3.10, at most one of the roots is right, and Proposition C.2 gives a fraud proof against the other.

### C.2 Watchers

**Watchers.** A **watcher** maintains a view itself, and compares its root with the claims it sees. A fraud proof is useful only if a watcher finds the error and the reader learns of it, which requires four things. **[no proof]** They are argued here, not proven to be sufficient.

1. **Someone recomputes.** At least one honest watcher maintains the view, at the same cost as the indexer, $O(|X|(h+1))$ per change for a pointwise lens (Proposition 3.12). Three kinds of party are natural watchers:
   - **Other indexers** of the same lens, who already maintain it at no extra cost.
   - **A publisher, for its own sub-log.** Because it knows the indices of its own updates from the ordering, it can check that none was omitted with one opening of $R$ per update, $O(\Delta_P (h+1))$ in all, without maintaining the view.
   - **Anyone paid by a bond** (C.4).
2. **A watcher sees the root.** A dishonest indexer can sign a wrong root and serve it to one reader only, in which case no watcher sees that root, and no fraud proof is ever found. There are two defences:
   - **Cross-checking.** The reader asks a second indexer, independent of the first, for its root for the same lens and $t$. Honest indexers agree exactly (Proposition 3.10), so a mismatch shows that one of them is wrong. Walking the two trees together (Lemma 6.1) finds each key where they differ in $O(h+1)$ nodes, and Proposition C.2 then says which indexer is wrong. This costs one more root per read, and fails only if every indexer asked is wrong in the same way, which in practice means collusion.
   - **Published claims.** The reader accepts only roots that are published where watchers look, whether posted to the ordering service or to a public feed of claims. Targeting a single reader then becomes impossible, at the cost of publishing each claim.
3. **The reader can complete the proof itself.** A fraud proof needs an opening of $R$, and an indexer can refuse to serve its nodes to watchers, without which a watcher cannot find $y$. The reader, however, already holds the nodes it read. It compares the slice it read with the same slice of an honest watcher's view, at the cost of reading that slice a second time, and any difference gives it $y$, with the opening of $R$ already in hand. The other half of the proof, the point read, comes from public authenticated data. Withholding nodes can thus stop a watcher from proving fraud to everyone about parts nobody has read, but it cannot hide fraud from a reader about what that reader read.
4. **There is no challenge window.** Nothing settles on a claim, and a reader acts on a view when it chooses. A later fraud proof gives it a correction, and, with a bond (§5), compensation. A reader about to do something it cannot undo should cross-check first. How long to wait, if at all, is each reader's choice rather than a parameter of the protocol.

**Shape.** The keys of a sub-log view are $(P, j)$, where the ordering assigns $j$. A publisher picks its own address, but not the indices its updates land at. **[no proof]** A publisher could choose its address, or time its updates to land at chosen indices, and whether either helps an attack on shape is not analysed.

### C.3 Bounded trees

A bounded tree (Definition 3.14) need not be a function of $V$, so it cannot be recomputed and compared. Its soundness, however, is a local property:

- **A false bound** has a fraud proof [proof], consisting of a node, a path of child names from it to a leaf $(x, v)$, and the fact that $\Vert v - \mu \Vert > \varepsilon$. Names fix every node on the path, so the proof costs one node per level and one distance.
- **A forged leaf**, whose $(x, v)$ is not an entry of $V$, has a fraud proof [proof], consisting of the leaf, the path to it, and a point read of the embedding view at $x$ (Proposition C.2).
- **[open] An omitted entry,** that is, an entry of $V$ with no leaf, has no succinct fraud proof given here. The tree is ordered by geometry rather than by key, so one opening cannot show that $x$ is absent. A count of leaves in each node, checked against the size of $V$, would turn an omission into a duplicate or a forged leaf somewhere, but the size of $V$ is an aggregate, and locating the fault is not shown to be succinct.

A sound tree therefore gives no false negatives among its leaves, and none at all once omissions can be ruled out.

### C.4 Bonds

**Bonds.** Holding an indexer to account (C.1) needs no contract, since a fraud proof convinces anyone who checks it. If readers want compensation, however, an indexer can post a bond to a contract that pays out to the first valid fraud proof against a claim the indexer signed.

- **For lenses over an update log,** the contract checks the log opening against the current peaks of the log the lens reads. A position stays at the same index as the log grows, so a proof against an old claim remains valid forever. The contract also rebuilds the map opening, at $O(h+1)$ nodes.
- **[estimate]** The gas cost is dominated by hashing the map nodes. Each node has about $2^b$ entries in expectation, and at most $B_{\max}$.
- **For lenses over slices,** the point read needs directory and state openings, and while checking those on-chain is possible, its cost is not given here.
- **Claims of any age.** A point read is taken as of the claim's $t$ (C.1), so a later update does not make an honest claim provably wrong. A contract may still accept proofs only against recent claims, to bound how long a bond stays exposed.

### C.5 Other lenses

**Other lenses.** Aggregates, joins, and general lenses are either not pointwise or not key-revealing, and a fraud proof against them needs the part of the input they read, which may be all of it. For these lenses, our position is the same as that of [TG]. **[open]** Succinct fraud proofs for them, for example by bisecting the computation, are not given here.

## References

| Key       | Reference                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AB09]    | S. Arora, B. Barak. Computational Complexity: A Modern Approach. Cambridge University Press, 2009                                                                                                                                                                   |
| [AT19]    | A. Auvolat, F. Taïani. Merkle Search Trees: Efficient State-Based CRDTs in Open Networks. SRDS 2019                                                                                                                                                                 |
| [CER]     | Ceramic. Protocol documentation, legacy specification, and the rust-ceramic pipeline design. developers.ceramic.network, github.com/ceramicnetwork, accessed 2026-10-13                                                                                             |
| [CIP124]  | Ceramic. CIP-124: Recon, tunable eventually-consistent event sharing. cips.ceramic.network, draft                                                                                                                                                                   |
| [FC]      | Farcaster. Protocol specification and Snapchain documentation. github.com/farcasterxyz, accessed 2026-10-13                                                                                                                                                         |
| [G01]     | O. Goldreich. Foundations of Cryptography, Volume 1: Basic Tools. Cambridge University Press, 2001                                                                                                                                                                  |
| [IPNS]    | IPFS. IPNS record and protocol specification. specs.ipfs.tech/ipns, accessed 2026-10-13                                                                                                                                                                             |
| [KFH+24]  | M. Kleppmann, P. Frazee, J. Gold, J. Graber, D. Holmgren, D. Ivy, J. Johnson, B. Newbold, J. Volpert. Bluesky and the AT Protocol: Usable Decentralized Social Media. ACM CoNEXT Workshop on the Decentralization of the Internet (DIN '24), 2024. arXiv:2402.03239 |
| [L78]     | L. Lamport. Time, Clocks, and the Ordering of Events in a Distributed System. CACM 21(7), 1978                                                                                                                                                                      |
| [LLK13]   | B. Laurie, A. Langley, E. Kasper. Certificate Transparency. RFC 6962, 2013                                                                                                                                                                                          |
| [MBB+15]  | M. Melara, A. Blankstein, J. Bonneau, E. Felten, M. Freedman. CONIKS: Bringing Key Transparency to End Users. USENIX Security 2015                                                                                                                                  |
| [MCRDT20] | H. Sanjuán, S. Pöyhtäri, P. Teixeira, I. Psaras. Merkle-CRDTs: Merkle-DAGs meet CRDTs. arXiv:2004.00107, 2020                                                                                                                                                       |
| [NIP01]   | Nostr. NIP-01: Basic protocol flow description. github.com/nostr-protocol/nips                                                                                                                                                                                      |
| [T16]     | P. Todd. Merkle Mountain Ranges. OpenTimestamps, 2016                                                                                                                                                                                                               |
| [TG]      | The Graph. Documentation: indexing overview and glossary. thegraph.com/docs, accessed 2026-10-13                                                                                                                                                                    |
| [TBL]     | Tableland. Documentation. docs.tableland.xyz, accessed 2026-10-13                                                                                                                                                                                                   |
