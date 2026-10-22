# Fangorn II: Programmable Access to Verifiable Data

*Working draft, 2026-10-13 · driemworks. The second of two papers. [WP1] gives the data model: data held by untrusted hosts, history ordered by a logical clock, and reads and indexes that anyone can check. This paper adds who may read. Part I is a general model of access as witness encryption. Part II instantiates it, with practical witness encryption built from zero-knowledge proofs and a key-release scheme.*

## 0. Introduction

On a platform, the party that serves the data also decides who may read it. So it sees every read, and watching readers becomes the cheapest way to pay for the service [ZUB19]. This is a property of the infrastructure, not of publishing: storage, authority and observation happen in one place. [WP1] removes the platform from storing, ordering and finding data. This paper removes it from reading.

A publisher can make data readable only by those who meet a condition it chooses, without any party deciding, case by case, who may read, and without any party learning who reads.

**Part I** gives a general model:
- **Access.** A sealed state is encrypted so that it can be read by exactly those who hold a witness for a condition. This is witness encryption, and the condition may refer to the ordering itself: membership, payment and time are all statements about the ordering.
- **Security.** Anyone who learns anything about a sealed state beyond its leakage could have satisfied the condition, and reading leaves no trace.

**Part II** approximates witness encryption with a zero-knowledge proof posted to the chain, together with a key-release scheme, which may be a single custodian, a trusted execution environment, or a threshold committee.

---

# Part I — The general model

## 1. Preliminaries

### 1.1 Conventions

This paper uses the notation, proof-status tags and algorithm conventions of [WP1, §1.1], and builds on its model: names, Merkle DAGs, the ordering service and its clock, Assumption O, the registry, and slices. A citation such as [WP1, Definition 1.9] refers to the companion paper. §5 lists every claim of this paper without a full proof.

### 1.2 Proofs

Proofs are over the NP relations of [WP1, §1.4].

**Definition 1.1 (SNARK) [BBBF18, Def. 8; LJKW18, Def. 4].** A **succinct non-interactive argument of knowledge** for $R$ is a triple $\Pi = (\mathsf{Gen}, \mathsf{Prove}, \mathsf{Verify})$ of polynomial-time algorithms, where $\mathsf{Gen}(1^\lambda) \to (\mathit{ek}, \mathit{vk})$, $\mathsf{Prove}(\mathit{ek}, x, w) \to \pi$ and $\mathsf{Verify}(\mathit{vk}, x, \pi) \in \{0, 1\}$. It satisfies:
1. **completeness:** for every $(x, w) \in R$, an honest proof is accepted with probability 1;
2. **succinctness:** the length of $\pi$, and the running time of $\mathsf{Verify}$, are bounded by $\mathrm{poly}(\lambda, \log(|x| + |w|))$;
3. **knowledge soundness:** for every adversary $\mathcal{A}$ in a stated class there is an extractor $\mathcal{E}_{\mathcal{A}}$, with a stated bound on its running time, such that for every auxiliary input $z$, the probability that $\mathcal{A}(z, \mathit{ek})$ outputs $(x, \pi)$ with $\mathsf{Verify}(\mathit{vk}, x, \pi) = 1$, while $\mathcal{E}_{\mathcal{A}}(z, \mathit{ek})$ outputs no $w$ with $(x, w) \in R$, is at most $\mathbf{Adv}^{\mathsf{ks}}_\Pi$.

[BBBF18] takes adversaries and extractors running in time $2^{o(\lambda)}$, and a negligible error. [LJKW18] gives a concrete form relative to an oracle: an adversary with at most $t$ operations and $q$ queries yields an extractor with at most $t'$ operations and $q'$ queries. Results that reduce to the hardness of a clock (§1.3) need the concrete form. There, the extractor's cost counts against the clock's bound.

**Recursion.** A proof can be updated at each step of a long computation, so that the proof for step $\tau + 1$ is computed from the proof for step $\tau$. This is incrementally verifiable computation [BBBF18, Def. 9]. Extracting a witness through such a chain of proofs costs time exponential in the depth of the recursion [BBBF18, §4]. So constructions use trees of proofs of bounded depth, and the knowledge soundness of a recursive proof over many steps is a hypothesis to state, not something that follows from Definition 1.1.

A proof may also be zero-knowledge and simulation-extractable.

**Definition 1.2 (Zero knowledge and simulation extractability) [informal; not taken from a source read for this document].** A proof may be bound to a message $m$, as $\mathsf{Prove}(\mathit{ek}, x, w, m)$ and $\mathsf{Verify}(\mathit{vk}, x, m, \pi)$.
1. **Zero knowledge:** a simulator that holds a trapdoor of $\mathsf{Gen}$, and is given only $x$ and $m$, outputs proofs indistinguishable from honest ones.
2. **Simulation extractability:** an adversary that has seen simulated proofs for pairs $(x, m)$ of its choice, and outputs an accepted proof for a pair it was not given, yields a witness for that $x$ through an extractor.

The second property is what stops a proof from being copied onto another message (§4.2).

### 1.3 Clocks

[WP1, Definition 1.9] gives the ordering service, with its checkpoints and its logical clock. $\mathsf{Verify}$ sees only $d$ and $\mathcal{O}'$. So what matters about a clock is what an adversary can make it accept.

**Definition 1.3 (Reference clock).** Let $R_{\mathsf{clk}}$ be the relation where $((d, \tau, r), w) \in R_{\mathsf{clk}}$ if $w$ is an extension of the checkpoint $d$ that $\mathsf{Verify}$ accepts, reaches clock value $\tau$, and has a state with root $r$. For a class $\mathcal{C}$ of adversaries, the ordering is:
1. **timely** for $\mathcal{C}$ if no adversary in $\mathcal{C}$ outputs a witness for $(d, \tau, \cdot)$ while the honest clock is below $\tau$, except with negligible probability;
2. **binding** for $\mathcal{C}$ if no adversary in $\mathcal{C}$ outputs a witness for $(d, \tau, r)$ where $r$ is not the honest root at $\tau$, except with negligible probability.

A clock can be timely without being binding. The class $\mathcal{C}$ is set by what the clock is made of:

| Clock | Made of | $\mathcal{C}$ | Timely | Binding |
| --- | --- | --- | --- | --- |
| Computational [LJKW18, Defs. 5–7, 10, 11] | Public, parallel work, as in proof of work | Adversaries with far less computation than the clock | Yes | No |
| Signed | Attestations under an acceptance rule | Adversaries that cannot produce an accepted attestation the honest signers did not make | Yes | Yes |
| Sequential [BBBF18, Defs. 1–4] | Chained evaluations of a verifiable delay function | Adversaries whose hardware is not much faster | Yes, [proof sketch] | No |

**Computational.** This is the computational reference clock of [LJKW18], who build time-lock encryption from it. Their notion of breaking the clock, a witness for $\tau$ from fewer operations than the clock spends, is a concrete failure of timeliness. Any chain that meets the relation is a witness, whatever its blocks hold, so the clock is not binding.

**Signed.** Each step carries attestations, and an **acceptance rule** says which attestations suffice. Examples:
- one server's signature;
- $k$ of $n$ committee signatures;
- a stake-weighted quorum of validators;
- the finality of the chain a rollup settles on.

**[assumption]** The rule's honesty assumption holds, and the signatures are unforgeable: the single server is honest, or fewer than $k$ of the committee are corrupt, and so on. Then the clock is timely, and also binding, because a step the honest signers never attested has no accepted attestation. Signers whose keys have retired may later leak or sell them, so $d$ must be recent. A signed clock is not a computational one, because its steps depend on secrets [LJKW18, §3].

**Sequential.** A verifiable delay function [BBBF18, Def. 1] has an evaluation $\mathsf{Eval}(\mathit{ek}, x) \to (y, \pi)$ that takes parallel time $t$, and a fast check of $(x, y, \pi)$. It is **$\sigma$-sequential** if no adversary, after preprocessing, computes $y$ for a random $x$ in parallel time $\sigma(t) < t$ [BBBF18, Def. 4]. The clock chains evaluations, $(y_i, \pi_i) = \mathsf{Eval}(\mathit{ek}, H(y_{i-1}, \mathit{aux}_i))$.

**[proof sketch, with $H$ as a random oracle]** No step's input is known before the previous output exists. So running $j$ steps ahead takes $j$ evaluations one after another, while the honest clock takes $t$ per step. How sequentiality composes over steps whose inputs the adversary partly chooses through $\mathit{aux}$ is not written out.

The clock needs no keys and no honest majority, but its margin is the adversary's hardware advantage. [BBBF18, §2]: with a 10-fold speedup, a forged history becomes convincing once it is more than a tenth as old as the genuine one.

**Definition 1.4 (Succinct clock).** A **succinct clock** over a reference clock is a SNARK $\Pi$ for $R_{\mathsf{clk}}$ (Definition 1.1). Its witness for $(d, \tau, r)$ is a proof $\pi$.

**Lemma 1.5 (A succinct clock keeps its clock's properties) [proof, given knowledge soundness in the concrete form].** If a clock is timely, or binding, for $\mathcal{C}$, then so is a succinct clock over it, up to $\mathbf{Adv}^{\mathsf{ks}}_\Pi$. This needs every adversary in $\mathcal{C}$, together with its extractor, to stay in $\mathcal{C}$.

*Proof.* From an accepted $\pi$, the extractor yields a witness $w$ for the same statement, which the clock's property rules out. This is the pattern of [LJKW18, Thm. 2]. $\square$

The hypothesis carries weight when $\pi$ is built by recursion over the clock's steps (§1.2). With a succinct clock, a statement about the contents at $\tau$ costs a constant-size proof plus one opening of $r$ ([WP1, Definition 1.6]).

**Assumption C (Clock).** The ordering is a reference clock (Definition 1.3), timely for a stated class $\mathcal{C}$. It is also binding if it is signed.

### 1.4 Witness encryption

**Definition 1.6 (Witness encryption [GGSW13]).** A witness encryption scheme for an NP relation $R$ is a pair of algorithms $\mathsf{WE} = (\mathsf{Enc}, \mathsf{Dec})$:
- $\mathsf{Enc}(1^\lambda, x, m)$ encrypts a message $m$ to a statement $x$, and outputs a ciphertext $c$;
- $\mathsf{Dec}(c, w)$ outputs a message, or $\bot$.

It is **correct** if, for every $x$, $m$ and $w$ with $R(x, w) = 1$, $\mathsf{Dec}(\mathsf{Enc}(1^\lambda, x, m), w) = m$.

Anyone holding a witness can decrypt, and nobody else needs to be involved: there is no key holder, and no party who decides.

**Definition 1.7 (Soundness security [GGSW13]).** For every $x \notin \mathcal{L}_R$ and every pair of equal-length messages $m_0, m_1$, no efficient adversary can tell $\mathsf{Enc}(1^\lambda, x, m_0)$ from $\mathsf{Enc}(1^\lambda, x, m_1)$, except with negligible advantage.

Soundness security says nothing when $x$ is true. The conditions we care about usually are true: someone is a member, someone could pay. We therefore need the stronger notion.

**Definition 1.8 (Extractable security [GKPVZ13]).** For every efficient adversary $\mathcal{A}$ and polynomial $p$, there is an efficient extractor $\mathcal{E}$ and a polynomial $q$ such that the following holds for every statement $x$, auxiliary input $z$ and pair of equal-length messages $m_0, m_1$. If

$$
\Big|\Pr\big[\mathcal{A}(x, z, \mathsf{Enc}(1^\lambda, x, m_0)) = 1\big] - \Pr\big[\mathcal{A}(x, z, \mathsf{Enc}(1^\lambda, x, m_1)) = 1\big]\Big| \ge 1/p(\lambda)
$$

then $\Pr[R(x, \mathcal{E}(x, z)) = 1] \ge 1/q(\lambda)$.

Informally, anyone who learns anything about $m$ could have computed a witness. Extractable witness encryption for every NP relation is not known to exist, and is implausible for some auxiliary inputs [GGHW14]. It is the right specification of conditional readability. Part II approximates it.

### 1.5 Symmetric encryption

Bulk data is encrypted with a symmetric scheme, and only its key is witness-encrypted. $\mathsf{SE} = (\mathsf{Enc}, \mathsf{Dec})$ takes a key $k$, a message and associated data. The scheme is deterministic, so equal blocks under one key give equal ciphertexts, and an unchanged block keeps its name.

**Definition 1.9 (DAE security [RS06]).** Under a uniform key, encryptions of distinct (message, associated data) pairs are indistinguishable from independent random strings of the same length, and forged ciphertexts are rejected. The advantage is $\mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}(\mathcal{A})$.

## 2. Access

### 2.1 Conditions

A **condition** is an NP relation $R_\phi$. Its statements have the form

$$
x = (\phi,\ A,\ e,\ d)
$$

where:
- $\phi$ names the condition;
- $A$ is the app;
- $e$ is an epoch;
- $d$ is the name of a checkpoint of $\mathcal{O}$.

As with the operations of [WP1, Definition 3.1], every statement and message below also names the registry $\iota$, so that a witness, proof or grant for one registry means nothing in another. The notation leaves $\iota$ out.

A witness $w$ for $x$ is whatever the condition asks for. It may include an extension of the ordering after $d$, accepted by $\mathsf{Verify}$. This is how a condition refers to things that happen after the data is sealed.

Conditions are **programmable**: any NP relation is a condition, and conditions compose,

$$
R_{\phi \wedge \psi}(x, (w_1, w_2)) = R_\phi(x, w_1) \wedge R_\psi(x, w_2), \qquad R_{\phi \vee \psi}(x, w) = R_\phi(x, w) \vee R_\psi(x, w)
$$

Examples:
- **Password.** $R(x, w) = 1$ iff $N(\texttt{pw}, w) = y$, for a value $y$ fixed in $\phi$.
- **Membership.** $w = (\mathit{sk}, \mathcal{O}')$, where $\mathcal{O}'$ extends the ordering after $d$ and records the enrollment of the commitment to $\mathit{sk}$ in $A$ for epoch $e$. With a succinct clock, $w = (\mathit{sk}, \pi, o)$: $\pi$ proves a clock statement $(d, \tau, r)$, and $o$ opens the state root $r$ at the enrollment.
- **Payment.** $w = (\mathit{sk}, \mathcal{O}')$, where $\mathcal{O}'$ extends the ordering and records a payment of the price for $(A, e)$, bound to the commitment to $\mathit{sk}$. With a succinct clock, the extension is replaced by a proof and an opening, as for membership.
- **Time.** $w = \mathcal{O}'$, an extension of the ordering that reaches clock value $T$, under a relation associated to the clock. The ordering itself is the witness [LJKW18]. With a succinct clock, $w$ is a proof for $(d, T, \cdot)$.
- **Credential.** $w$ is a credential from a fixed issuer that satisfies a fixed predicate.

In every example except the password and the credential, the witness is a piece of the ordering. The ordering is what a reader proves things about. This is why one ordered log is enough to express membership, payment and time as conditions on reading.

**Private forks.** Witness encryption consults no one, so a witness extension $\mathcal{O}'$ is never compared with the honest ordering. An adversary can build a **private fork**: an extension of $d$ that it never publishes, in which it enrolls or pays, followed by $k$ further steps. What stops it is whether the clock is binding (Definition 1.3):
- **If it is binding,** as a signed clock is, the fork needs attestations that the honest signers never made, and under the clock's assumption it cannot be built.
- **If it is only timely,** as a computational or sequential clock is, the fork is a valid witness once it is built. Building it never gets ahead of the honest clock, so it breaks nothing. It costs the work, or the sequential time, of every step from $d$ to $k$ steps past the entry, and given time any adversary can do it. **[no proof]** Membership and payment are then secure only economically. The depth $k$ must make that cost exceed what the condition is worth, for payment the price. [LJKW18, §1.1.1] make the same comparison for decrypting early.

With a succinct clock, the same holds for the extension that the extractor yields (Lemma 1.5).

The time condition is protected by the clock in every case (Proposition 3.1).

In the instantiation of §4, private forks do not arise in the same way. A grant (§4.2) is recorded on the real chain, and a fork cannot produce one. The clock assumption moves to the key-release scheme: its custodian, enclave or committee must follow the honest chain.

### 2.2 Sealing

This paper extends the app tuple [WP1, §2] with a **condition** $\phi_A$, under which the app's sealed repos can be read:

$$
A = (n_A,\ o_A,\ \phi_A,\ \chi_A)
$$

Like the rest of the tuple, $\phi_A$ is fixed when the app is created. A repo of $A$ is **public** or **sealed**. A sealed repo has a public directory entry. Its records are part of $\mathcal{G}_t$, but only a reader holding its key can open them.

For each epoch $e$ in which a sealed repo $\rho$ is written, its publisher:
1. samples a key $k_{\rho,e}$;
2. encrypts every node of the new state with $\mathsf{SE}.\mathsf{Enc}_{k_{\rho,e}}(\cdot\,; (\rho, e))$, including the records, the internal nodes and the root;
3. publishes $c_{\rho,e} = \mathsf{WE}.\mathsf{Enc}\big(1^\lambda,\ x_{A,e},\ k_{\rho,e}\big)$, where $x_{A,e} = (\phi_A, A, e, d)$ and $d$ is a recent checkpoint.

The commit itself stays public: its epoch, parent and root are the fields of the update, which the registry checks and names [WP1, Definition 3.1]. So the epoch that keys a sealed state is fixed by the ordering, within the window of $W$ epochs that the registry allows. A sealed node is named by $N$ of its ciphertext, so the sealed state is still a Merkle DAG.

To read sealed repo $\rho$ at epoch $e$, a reader holding a witness $w$ for $x_{A,e}$ computes $k_{\rho,e} = \mathsf{WE}.\mathsf{Dec}(c_{\rho,e}, w)$. It then reads as in [WP1, §3.3], decrypting each node under associated data $(\rho, e)$. One witness opens every sealed repo of $A$ for that epoch, because they all share the statement $x_{A,e}$.

**Leakage.** A sealed commit reveals:
- $\rho$, its position, its epoch and its parent, and the clock value of its update, which the update log records [WP1, §3.2];
- the number and sizes of the nodes it adds;
- which of those nodes equal nodes already present in the same epoch.

We write $\mathsf{Leak}(M)$ for this information about a state $M$. It does not include keys, types or payloads.

**Revocation.** Access is granted per epoch: a member not enrolled for a later epoch holds no witness for it. The publisher chooses $e$ within the window [WP1, §3.2], so a state published up to $W$ epochs after the audience changes can still be sealed for the earlier audience. Revocation therefore takes effect after $W$ epochs. An update that lands too late is invalid, and its publisher seals the state again under the current epoch. Keys already obtained, and states already read, stay with their holders.

### 2.3 Sealed views

A lens over a sealed repo can be computed only by readers who hold its key, and its view is derived from sealed records. **[requirement; no proof that it suffices]** A view committed as a repo must be sealed so that every party able to read the view is able to read the input. Otherwise the view publishes what the seal protects. What a view leaks to parties who can read neither is not analysed here. Lenses over the public part of a sealed repo are open to everyone. That public part is its directory entries, its log entries, and $\mathsf{Leak}$.

The same rule covers the views of [WP1, §3.4] that reveal content, such as embeddings, and search indexes [WP1, §3.5]: an embedding view or a search index over sealed records is a sealed view. A public search index should be built over public records only.

## 3. Security

### 3.1 Confidentiality

The following game fixes a sealed repo $\rho$ of app $A$, and an epoch $e$.

$$
\begin{array}{rl}
\hline
& \textbf{Experiment } \mathsf{Conf}^{b}_{\mathcal{A}}(\rho, e) \\
\hline
1: & \mathcal{A} \text{ chooses two states } M_0, M_1 \text{ with } \mathsf{Leak}(M_0) = \mathsf{Leak}(M_1) \\
2: & \text{the challenger seals } M_b \text{ as } \rho\text{'s state in epoch } e\text{, and gives } \mathcal{A} \text{ every public value: } \mathcal{O}\text{, } c_{\rho,e}\text{, and every sealed node} \\
3: & \mathcal{A} \text{ outputs } b' \\
\hline
\end{array}
$$

**Theorem 1 (Conditional confidentiality) [proof].** Let $\mathsf{WE}$ have extractable security, and $\mathsf{SE}$ be DAE-secure. For every efficient $\mathcal{A}$ and polynomial $p$, if

$$
\big|\Pr[\mathsf{Conf}^0_{\mathcal{A}} = 1] - \Pr[\mathsf{Conf}^1_{\mathcal{A}} = 1]\big| \ge 1/p(\lambda) + \mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}
$$

then an efficient extractor, given what $\mathcal{A}$ was given, outputs a witness for $x_{A,e}$ with non-negligible probability.

In words, anyone who learns anything about a sealed state beyond its leakage could have satisfied the condition.

*Proof.* Consider a hybrid in which $c_{\rho,e}$ encrypts an independent random key instead of $k_{\rho,e}$. In the hybrid, $k_{\rho,e}$ appears only as the key of $\mathsf{SE}$. By DAE security, the sealed nodes of $M_0$ and of $M_1$ are each indistinguishable from random strings of the sizes and repetition pattern that $\mathsf{Leak}$ gives, and these are equal by assumption. So in the hybrid, $\mathcal{A}$'s advantage is at most $\mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}$.

Therefore, if $\mathcal{A}$'s advantage in the real game is at least $1/p(\lambda) + \mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}$, then $\mathcal{A}$, with the rest of its view as auxiliary input, distinguishes $\mathsf{WE}.\mathsf{Enc}(x_{A,e}, k_{\rho,e})$ from $\mathsf{WE}.\mathsf{Enc}(x_{A,e}, k')$ with advantage at least $1/p(\lambda)$. By extractable security, the extractor outputs a witness for $x_{A,e}$. $\square$

What counts as "could have satisfied the condition" depends on the condition. For payment, anyone who can extend the ordering with a payment can satisfy it, which is the intent: anyone who pays may read. For membership, only those who can produce an enrollment can.

**Proposition 3.1 (The time condition reduces to the clock) [proof sketch].** Let the ordering be timely for $\mathcal{C}$ (Definition 1.3). Suppose $\mathsf{WE}$ is extractable relative to the clock, in the concrete form of [LJKW18, Def. 3], with an extractor that stays in $\mathcal{C}$. Then an adversary in $\mathcal{C}$ that distinguishes a state sealed for time $\tau$, in the game of Theorem 1, with advantage beyond $\mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}$, yields a witness for $\tau$ before the honest clock reaches it, which timeliness rules out.

*Sketch.* The hybrid of Theorem 1 reduces the state to the key $k_{\rho,e}$. On the key, run the extractor. For a computational clock this is [LJKW18, Thm. 3]. What is not written out is how the two pieces compose: the hybrid uses Definition 1.8, while the step on the key needs the concrete form. $\square$

With a signed clock, the time condition can also be met directly: the honest signers attest to the required clock value, which is the committee scheme of §4.3, item 4.

### 3.2 Reader privacy

**Theorem 2 (Reader privacy) [proof].** Decrypting a sealed repo is a local computation on public values. For any two readers that hold witnesses for $x_{A,e}$, the views of all other parties are identical whether either, both or neither of them decrypts.

*Proof.* $\mathsf{WE}.\mathsf{Dec}$ and $\mathsf{SE}.\mathsf{Dec}$ take only the reader's witness and public values, and send nothing. Fetching nodes by name from public hosts is the same for every reader of the repo. $\square$

Reading leaves no trace in the general model. Whatever a reader reveals, it reveals while obtaining its witness: the entries a membership or payment witness requires. Reader privacy therefore reduces to the privacy of those entries. For example, an enrollment or a payment can be made under a commitment to a secret, through a relayer, so that the ordering does not link it to the reader.

---

# Part II — Instantiation

## 4. Practical witness encryption

**The chain as a clock.** A proof-of-work chain is a computational reference clock [LJKW18, §5]: a valid chain of headers that meets a bound on targets is evidence that the corresponding time has passed. The chain of [WP1, §5], taken here to be an EVM rollup, is a **signed** clock (Definition 1.3), not a computational one. Its acceptance rule is the finality of the chain it settles on, together with the rollup's own mechanism for proving or disputing its state, and $\delta$ includes that chain's finality delay, which for a light reader that does not trust the proposer is the rollup's settlement time [WP1, §5]. A light reader can verify it succinctly. A validity proof of the rollup's state against the chain it settles on, together with a proof of that chain's attestations, makes it a succinct clock over a signed one (Definition 1.4). How to build that proof is out of scope (§7).

### 4.1 The ideal and the gap

Practical witness encryption for the relations of §2.1 does not exist. We replace it with an ideal functionality, and realize that functionality with two components.

**Definition 4.1 (Release functionality).** $\mathcal{F}_{\mathsf{rel}}$ holds the keys $k_{\rho,e}$ that publishers deposit. On input a witness $w$ for $x_{A,e}$, it returns $k_{\rho,e}$ for every sealed repo $\rho$ of $A$ in epoch $e$. It reveals nothing else.

A system that realizes $\mathcal{F}_{\mathsf{rel}}$ satisfies Theorem 1, with "an extractor outputs a witness" replaced by "the functionality was given a witness". The question is who is trusted to realize it.

### 4.2 Construction: a proof on the chain, and a release scheme

The construction has two components.

**Zero-knowledge proofs of knowledge.** A proof system $\Pi$ for $R_{\phi_A}$ that is zero-knowledge and simulation-extractable (Definition 1.2). Each proof is bound to a message that the verifier computes itself.

**A key-release scheme.** A party, or set of parties, that holds the deposited keys and releases them according to the chain.

The construction runs in three steps.
1. **Seal.** The publisher encrypts the state under $k_{\rho,e}$ as in §2.2, and deposits $k_{\rho,e}$ with the release scheme, in place of publishing $c_{\rho,e}$.
2. **Prove.** A reader with witness $w$ for $x_{A,e}$:
   - generates a fresh key pair $(\mathit{sk}', \mathit{pk}')$;
   - computes a pseudonym $\nu = \mathsf{PRF}(\mathit{sk}, (A, e))$ from the secret in its witness;
   - posts $(x_{A,e}, \mathit{pk}', \nu, \pi)$ to the chain, through a relayer, where $\pi$ proves knowledge of $w$ with $R_{\phi_A}(x_{A,e}, w) = 1$ and that $\nu$ is computed correctly.

   The proof is bound to the message $(A, e, \mathit{pk}')$. The chain verifies $\pi$, rejects a pseudonym it has already seen, and records a **grant** $(A, e, \mathit{pk}')$.
3. **Release.** On a grant, the release scheme publishes $k_{\rho,e}$ encrypted to $\mathit{pk}'$, for every sealed repo $\rho$ of $A$.

**Theorem 3 (The construction realizes $\mathcal{F}_{\mathsf{rel}}$) [proof sketch].** If $\Pi$ is simulation-extractable and zero-knowledge, the chain satisfies [WP1, Assumption O], and the release scheme releases keys exactly on grants, then the construction realizes $\mathcal{F}_{\mathsf{rel}}$. Moreover:
1. each key reaches only the holder of $\mathit{sk}'$ for a recorded grant;
2. each grant comes with an extractable witness for $x_{A,e}$;
3. the public values of a grant reveal nothing about which witness was used, beyond the condition's anonymity set;
4. a witness yields one grant per $(A, e)$.

*Sketch.*
1. Release happens only on a grant, and only to $\mathit{pk}'$.
2. A grant is recorded only for a valid proof whose message the chain fixes. A proof not produced by an honest reader is a proof for a new (statement, message) pair, and simulation extractability yields a witness. Because the message includes $\mathit{pk}'$, a copied proof grants a key the copier does not hold.
3. By zero knowledge, $\pi$ can be simulated from the statement alone, and $\nu$ is a pseudorandom value for a fresh scope.
4. The pseudonym is a function of the witness's secret and $(A, e)$, it is part of the proven statement, and the chain accepts each pseudonym once.

$\square$

### 4.3 Key-release schemes

The construction leaves one component open: who holds the keys. The schemes below differ in who can read every key, and who must be online.

1. **A single custodian.** One party holds every key, and releases on grants.
   - **Trust:** it can read every sealed repo, and could release without a grant, undetected.
   - **Liveness:** it must be online.
   - It never learns a reader's witness, and its refusals are visible, because grants are public.
2. **A trusted execution environment.** The custodian runs inside an enclave whose attested code releases only on grants it has verified against the chain itself.
   - **Trust:** nobody reads the keys unless the enclave is broken. Physical attacks on current hardware are known [TEEF25].
   - **Liveness:** the enclave must be online.
3. **A threshold committee.** Keys are encrypted to the tag $(A, e)$ under signature-based witness encryption [MCF24, SWE24], with a committee set up without a dealer [GKPW24, WW26]. Members sign the tag when the chain shows a grant, and $t$ signatures decrypt.
   - **Trust:** no coalition below the threshold can read a key.
   - **Liveness:** any $t$ of the $n$ members suffice.

   This is the closest to the general model. The committee replaces the extractor of Definition 1.8 with an honest-threshold assumption, and nobody holds the keys.
4. **Time alone.** For the time condition, a committee signs each tag when the chain's clock reaches its value. No proof from the reader is needed.

**Exclusions and keys.** An exclusion names a publisher, a repo, or one key of a repo [WP1, Definition 3.1]. Over a sealed repo it hides what it covers from the presented state, as over a public one. While a publisher or a repo is excluded, a single custodian or an enclave can also stop releasing the keys of its repos, and release them again on a restore. A key exclusion cannot be enforced this way, because $k_{\rho,e}$ opens the whole repo for the epoch. Keys already released stay with their holders. The registry names an excluded key by its hash [WP1, §5], so excluding a record of a sealed repo reveals the hash of its key, which hides only a key that cannot be guessed. The threshold scheme, as described in item 3, cannot withhold keys for one repo. One signature on the tag $(A, e)$ opens every sealed repo of $A$ for epoch $e$, and the ciphertexts are public. Withholding a single repo would need a tag per repo, at the cost of one more signature per repo per grant.

In all four, a reader who receives a key can share it, exactly as a reader who decrypts under true witness encryption can share the plaintext.

## 5. Scope

**Missing proofs.** These claims are stated without a full proof:
- **Theorem 3.** Only a sketch is given.
- **Proposition 3.1.** It is a sketch: composing Theorem 1's hybrid with the concrete, oracle form of extractable security of [LJKW18, Def. 3] is not written out.
- **Private forks under a computational clock (§2.1).** Membership and payment are secure only economically, and how deep an entry must be settled is not derived.
- **Definition 1.3.** The reference clock, and its binding property, are this paper's own. [LJKW18]'s computational reference clock is the timely case. The security of a signed clock is an assumption.
- **Sequential clocks (§1.3).** That running $j$ steps ahead costs $j$ sequential evaluations is a sketch.
- **Lemma 1.5.** It holds given knowledge soundness in the concrete form. For proofs built by recursion over many steps, that is a hypothesis (§1.2).
- **Definition 1.2.** Zero knowledge and simulation extractability are stated informally.
- **The rule for sealed views (§2.3).** It is a requirement, with no analysis of what a view leaks.
- **Clock skew (§3.1).** With the chain's timestamps as the clock [WP1, §5], a proposer can set them ahead within their skew bound, and so meet a time condition early by up to that bound. The bound is assumed. A deployment that cannot accept it can state time conditions in block heights.

This document omits the following, each of which builds on it:
- how to build a succinct clock for the chain of [WP1, §5];
- the construction of anonymous payment;
- cumulative access to earlier epochs through key regression [FKK06];
- exclusions in sealed repos: whether a key exclusion names the plaintext key, so that a moderator must be able to decrypt it, and how point reads and the fraud proofs of [WP1, §3.5] apply to sealed slices;
- where the grant and enrollment programs live relative to the registry, beyond naming $\iota$;
- the cost of committing again under a new epoch, after a late update [WP1, §3.2], which re-encrypts every node of the state under the new key.

## References

| Key | Reference |
| --- | --- |
| [BBBF18] | D. Boneh, J. Bonneau, B. Bünz, B. Fisch. Verifiable Delay Functions. CRYPTO 2018 (ePrint 2018/601, version of 26 June 2019) |
| [FKK06] | K. Fu, S. Kamara, T. Kohno. Key Regression: Enabling Efficient Key Distribution for Secure Distributed Storage. NDSS 2006 |
| [GGHW14] | S. Garg, C. Gentry, S. Halevi, D. Wichs. On the Implausibility of Differing-Inputs Obfuscation and Extractable Witness Encryption with Auxiliary Input. CRYPTO 2014 |
| [GGSW13] | S. Garg, C. Gentry, A. Sahai, B. Waters. Witness Encryption and Its Applications. STOC 2013 |
| [GKPVZ13] | S. Goldwasser, Y. T. Kalai, R. A. Popa, V. Vaikuntanathan, N. Zeldovich. How to Run Turing Machines on Encrypted Data. CRYPTO 2013 |
| [GKPW24] | S. Garg, D. Kolonelos, G.-V. Policharla, M. Wang. Threshold Encryption with Silent Setup. CRYPTO 2024 |
| [LJKW18] | J. Liu, T. Jager, S. A. Kakvi, B. Warinschi. How to Build Time-Lock Encryption. Designs, Codes and Cryptography, 2018 |
| [MCF24] | N. Döttling, L. Hanzlik, B. Magri, S. Wohnig. McFly: Verifiable Encryption to the Future Made Practical. FC 2024 |
| [RS06] | P. Rogaway, T. Shrimpton. Deterministic Authenticated-Encryption. Eurocrypt 2006 |
| [SWE24] | G. Avitabile, N. Döttling, B. Magri, C. Sakkas, S. Wohnig. Signature-based Witness Encryption with Compact Ciphertext. Asiacrypt 2024 |
| [TEEF25] | TEE.Fail, October 2025 |
| [WP1] | driemworks. Fangorn I: Verifiable Data without a Platform. Working draft, 2026-10-13 |
| [WW26] | B. Waters, D. J. Wu. Silent Threshold Cryptography from Pairings. Eurocrypt 2026 |
| [ZUB19] | S. Zuboff. The Age of Surveillance Capitalism. 2019 |
