# Fangorn II: Programmable Access to Verifiable Data

_Working draft, 2026-10-30 · driemworks. The second of two papers. [WP1] gives the data model: data held by untrusted hosts, history ordered by a logical clock, and reads and indexes that anyone can check. This paper adds who may read. Part I is a general model of access as witness encryption. Part II instantiates it, with practical witness encryption built from zero-knowledge proofs and a key-release scheme._

## 0. Introduction

On a platform, the party that serves the data also decides who may read it. So it sees every read, and watching readers becomes the cheapest way to pay for the service [ZUB19]. This is a property of the infrastructure, not of publishing: storage, authority and observation happen in one place. [WP1] removes the platform from storing, ordering and finding data. This paper removes it from reading.

A publisher can make data readable only by those who meet a condition it chooses, without any party deciding, case by case, who may read, and without any party learning who reads. The condition belongs to the publisher's repo, not to any app that presents it: a publisher sets it once, and every app that presents the repo, and every reader who finds it, meets the same condition. An app that leads a reader to a purchase is paid a share of it, so that curating data pays without buying it.

**Part I** gives a general model:

- **Access.** A sealed state, or the sealed fields of a state, are encrypted so that they can be read by exactly those who hold a witness for a condition the publisher sets. This is witness encryption, and the condition may refer to the ordering itself: membership, payment and time are all statements about the ordering.
- **Referral.** A payment names the app that referred it, and the payment program splits the price between the publisher and that app, at a share the publisher sets.
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

[WP1, Definition 1.10] gives the ordering service, with its checkpoints and its logical clock. $\mathsf{Verify}$ sees only $d$ and $\mathcal{O}'$. So what matters about a clock is what an adversary can make it accept.

**Definition 1.3 (Reference clock).** Let $R_{\mathsf{clk}}$ be the relation where $((d, \tau, r), w) \in R_{\mathsf{clk}}$ if $w$ is an extension of the checkpoint $d$ that $\mathsf{Verify}$ accepts, reaches clock value $\tau$, and has a state with root $r$. For a class $\mathcal{C}$ of adversaries, the ordering is:

1. **timely** for $\mathcal{C}$ if no adversary in $\mathcal{C}$ outputs a witness for $(d, \tau, \cdot)$ while the honest clock is below $\tau$, except with negligible probability;
2. **binding** for $\mathcal{C}$ if no adversary in $\mathcal{C}$ outputs a witness for $(d, \tau, r)$ where $r$ is not the honest root at $\tau$, except with negligible probability.

A clock can be timely without being binding. The class $\mathcal{C}$ is set by what the clock is made of:

| Clock                                     | Made of                                            | $\mathcal{C}$                                                                           | Timely              | Binding |
| ----------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------- | ------- |
| Computational [LJKW18, Defs. 5–7, 10, 11] | Public, parallel work, as in proof of work         | Adversaries with far less computation than the clock                                    | Yes                 | No      |
| Signed                                    | Attestations under an acceptance rule              | Adversaries that cannot produce an accepted attestation the honest signers did not make | Yes                 | Yes     |
| Sequential [BBBF18, Defs. 1–4]            | Chained evaluations of a verifiable delay function | Adversaries whose hardware is not much faster                                           | Yes, [proof sketch] | No      |

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

_Proof._ From an accepted $\pi$, the extractor yields a witness $w$ for the same statement, which the clock's property rules out. This is the pattern of [LJKW18, Thm. 2]. $\square$

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
x = (\phi,\ \sigma,\ e,\ d)
$$

where:

- $\phi$ names the condition;
- $\sigma$ is the **subject**: a repo $\rho$, or one record of it, $(\rho, k)$, so that a publisher can set a different condition, and a different price, for every record (§2.2);
- $e$ is an epoch;
- $d$ is the name of a checkpoint of $\mathcal{O}$.

The subject is a repo or a record, never an app. An app cites data [WP1, §2], but what it takes to read the data is fixed by its publisher, and is the same in every app that cites it.

As with every value signed apart from the ordering [WP1, §3.2], every statement and message below also names the registry $\iota$, so that a witness, proof or grant for one registry means nothing in another. The notation leaves $\iota$ out.

A witness $w$ for $x$ is whatever the condition asks for. It may include an extension of the ordering after $d$, accepted by $\mathsf{Verify}$. This is how a condition refers to things that happen after the data is sealed.

Conditions are **programmable**: any NP relation is a condition, and conditions compose,

$$
R_{\phi \wedge \psi}(x, (w_1, w_2)) = R_\phi(x, w_1) \wedge R_\psi(x, w_2), \qquad R_{\phi \vee \psi}(x, w) = R_\phi(x, w) \vee R_\psi(x, w)
$$

Examples:

- **Password.** $R(x, w) = 1$ iff $N(\texttt{pw}, w) = y$, for a value $y$ fixed in $\phi$.
- **Membership.** $w = (\mathit{sk}, \mathcal{O}')$, where $\mathcal{O}'$ extends the ordering after $d$ and records the enrollment of the commitment to $\mathit{sk}$ in a group for epoch $e$, such as the members of an app $A$ that $\phi$ names. With a succinct clock, $w = (\mathit{sk}, \pi, o)$: $\pi$ proves a clock statement $(d, \tau, r)$, and $o$ opens the state root $r$ at the enrollment.
- **Payment.** $w = (\mathit{sk}, \mathcal{O}')$, where $\mathcal{O}'$ extends the ordering and records a payment of the price that $\phi$ names for $(\sigma, e)$, bound to the commitment to $\mathit{sk}$. With a succinct clock, the extension is replaced by a proof and an opening, as for membership.
- **Time.** $w = \mathcal{O}'$, an extension of the ordering that reaches clock value $T$, under a relation associated to the clock. The ordering itself is the witness [LJKW18]. With a succinct clock, $w$ is a proof for $(d, T, \cdot)$.
- **Credential.** $w$ is a credential from a fixed issuer that satisfies a fixed predicate.

**Bundles.** A publisher that wants its repo read by the members of an app $A$, as well as by those who pay, sets $\phi = \mathsf{pay}(p) \vee \mathsf{member}(A)$. This is how an app sells one membership over the data of many publishers: each publisher opts in through its own condition, and none is included without it. Since a grant is per subject (§4.2), a member proves its membership once for each repo it reads in an epoch, rather than once for the app. How a bundle's revenue reaches the publishers in it is not part of this paper (§5).

In every example except the password and the credential, the witness is a piece of the ordering. The ordering is what a reader proves things about. This is why one ordered log is enough to express membership, payment and time as conditions on reading.

**Private forks.** Witness encryption consults no one, so a witness extension $\mathcal{O}'$ is never compared with the honest ordering. An adversary can build a **private fork**: an extension of $d$ that it never publishes, in which it enrolls or pays, followed by $k$ further steps. What stops it is whether the clock is binding (Definition 1.3):

- **If it is binding,** as a signed clock is, the fork needs attestations that the honest signers never made, and under the clock's assumption it cannot be built.
- **If it is only timely,** as a computational or sequential clock is, the fork is a valid witness once it is built. Building it never gets ahead of the honest clock, so it breaks nothing. It costs the work, or the sequential time, of every step from $d$ to $k$ steps past the entry, and given time any adversary can do it. **[no proof]** Membership and payment are then secure only economically. The depth $k$ must make that cost exceed what the condition is worth, for payment the price. [LJKW18, §1.1.1] make the same comparison for decrypting early.

With a succinct clock, the same holds for the extension that the extractor yields (Lemma 1.5).

The time condition is protected by the clock in every case (Proposition 3.1).

In the instantiation of §4, private forks do not arise in the same way. A grant (§4.2) is recorded on the real chain, and a fork cannot produce one. The clock assumption moves to the key-release scheme: its custodian, enclave or committee must follow the honest chain.

### 2.2 Sealing

This paper gives each subject a **condition** $\phi_\sigma$, under which what is sealed in it can be read. A repo's condition $\phi_\rho$ is the default for its records, and a record's own condition $\phi_{(\rho,k)}$, where its publisher sets one, overrides it, so that each photo in a repo of photos can have its own price. A condition is set by **terms**: a value

$$
\mathit{terms} = (\iota,\ \sigma,\ \phi,\ s,\ n,\ t_x)
$$

signed by the publisher of $\sigma$, naming the subject, the condition, a curator share $s$ (§2.4), a **generation** $n$, and a deadline $t_x$. Terms are not entries of the ordering: the publisher signs them once, publishes them as a public field of the record or of the repo, and anyone who meets the condition carries them to the payment program, which checks the signature (§2.4). Setting a price, or a different price for every record, therefore costs nothing on the chain. The payment program keeps one counter per repo, the generation, which only its publisher may raise, and accepts terms only of the current generation and before their deadline, so that raising it voids every earlier price at once. Each sealed value names, in its statement, the condition it was sealed under, so a new condition applies to what is sealed after it, and never to what was sealed before. A repo with no condition is **public**. A sealed repo has a public directory entry, and its records are part of $\mathcal{G}_t$, but what is sealed in them opens only to a reader holding a key. A repo is sealed in one of two modes, which its publisher chooses.

**State sealing.** For each epoch $e$ in which $\rho$ is written, its publisher:

1. samples a key $k_{\rho,e}$;
2. encrypts every node of the new state with $\mathsf{SE}.\mathsf{Enc}_{k_{\rho,e}}(\cdot\,; (\rho, e))$, including the records, the internal nodes and the root;
3. publishes $c_{\rho,e} = \mathsf{WE}.\mathsf{Enc}\big(1^\lambda,\ x_{\rho,e},\ k_{\rho,e}\big)$, where $x_{\rho,e} = (\phi_\rho, \rho, e, d)$ and $d$ is a recent checkpoint.

The subject is the whole repo, since its keys are themselves sealed.

**Field sealing.** The state is public, except for the fields of each record that the publisher marks as sealed. For each epoch $e$ in which $\rho$ is written, its publisher samples $k_{\rho,e}$, derives a key $k_{\rho,e,k} = \mathsf{KDF}(k_{\rho,e}, k)$ for each record key $k$, and replaces each sealed value $v$ of field $a$ in record $k$ with $\mathsf{SE}.\mathsf{Enc}_{k_{\rho,e,k}}(v\,; (\rho, e, k, a))$. It publishes $c_{\rho,e}$ as above, and may also publish $c_{\rho,e,k} = \mathsf{WE}.\mathsf{Enc}(1^\lambda, x_{(\rho,k),e}, k_{\rho,e,k})$ for each record, so that one record can be read without the rest. $k_{\rho,e,k}$ reveals nothing of $k_{\rho,e}$, or of any other record's key, if $\mathsf{KDF}$ is a PRF.

Field sealing is what lets data be found without being read. The public fields of a record, such as a title, tags, a thumbnail or a preview, are the publisher's chosen leakage: any reader, indexer or app may read them, and build public views of them (§2.3), while the sealed fields, such as the full image, open only under the condition.

The commit itself stays public: its epoch, parent and root are the fields of the update, which the registry checks and names [WP1, Definition 3.1]. So the epoch that keys a sealed state is fixed by the ordering, within the window of $W$ epochs that the registry allows. A sealed node or value is named by $N$ of its ciphertext, so the sealed state is still a Merkle DAG.

To read subject $\sigma$ at epoch $e$, a reader holding a witness $w$ for $x_{\sigma,e}$ computes its key with $\mathsf{WE}.\mathsf{Dec}$, then reads as in [WP1, §3.3], decrypting under the same associated data. A witness for a repo opens every record of that repo for the epoch, and nothing of any other repo.

**Leakage.** A sealed commit reveals:

- $\rho$, its position, its epoch and its parent, and the clock value of its update, which the update log records [WP1, §3.2];
- the number and sizes of the nodes it adds, or under field sealing, of the sealed values;
- which of those nodes, or values, equal ones already present in the same epoch;
- under field sealing, the whole state except its sealed values: every key, every type, and every public field.

We write $\mathsf{Leak}(M)$ for this information about a state $M$. Under state sealing, it does not include keys, types or payloads.

**Revocation.** Access is granted per epoch: a member not enrolled for a later epoch holds no witness for it. The publisher chooses $e$ within the window [WP1, §3.2], so a state published up to $W$ epochs after the audience changes can still be sealed for the earlier audience. Revocation therefore takes effect after $W$ epochs. An update that lands too late is invalid, and its publisher seals the state again under the current epoch. Keys already obtained, and states already read, stay with their holders.

### 2.3 Sealed views

A lens over what is sealed can be computed only by readers who hold its key, and its view is derived from sealed values. **[requirement; no proof that it suffices]** A view committed as a repo must be sealed so that every party able to read the view is able to read the input. Otherwise the view publishes what the seal protects. What a view leaks to parties who can read neither is not analysed here. Lenses over the public part of a sealed repo are open to everyone. That public part is its directory entries, its log entries, and $\mathsf{Leak}$, which under field sealing includes every public field.

The same rule covers the views of [WP1, §3.4] that reveal content, such as embeddings, and search indexes [WP1, §3.5]: an embedding view or a search index over sealed records is a sealed view. A public search index should be built over public values only. Under field sealing, those include the public fields of sealed repos, so a public index can hold every record of a sealed repo, keyed and embedded by what its publisher chose to show, and point to sealed values that it cannot open. This is how an app curates data it has not bought.

An app may want a view of sealed values, such as an embedding of a full image under its own model, without buying every record. That requires releasing $f(v)$ for a named lens $f$ rather than $v$, which a key-release scheme that runs code could do (§4.3, item 2), under a condition that names the lenses the publisher allows. It is not constructed here (§5).

### 2.4 Referral

Under a payment condition, the payment is made to a program on the ordering, which pays the publisher. A publisher that wants its data curated sets, with its price $p$, a **curator share** $s \in [0, 1]$ in its terms. A payment carries the terms, and may name a **referrer** $r$, an app's repo [WP1, §2]. The program then pays $s \cdot p$ to the publisher of $r$, its curator, and $(1 - s) \cdot p$ to the publisher of the subject, unless no referrer is named, or the publisher **denies** $r$, in which case it pays all of $p$ to the publisher. The program keeps, for each publisher, the curators it denies, which only that publisher may change. A denial is the publisher's recourse against an app it does not want to be associated with: it cannot stop the app from citing public data, any more than a web page can stop a link [WP1, §2], but it stops the app from earning from it, and an honest frontend may also decline to show an app that a publisher denies.

The referrer is not part of the statement $x_{\sigma,e}$, and a witness opens the same key whoever referred the payment. Referral changes who is paid, never who may read.

What this gives each party:

- **A publisher** sets $p$ and $s$ once, and is paid on every sale, by whatever app made it.
- **An app** is paid for every sale it refers, without buying, holding or reading what it presents. It competes with other apps that present the same data on how well it leads readers to it, since the share is the same for all of them.
- **A reader** pays $p$, whichever app it came through.

**[no proof] Self-referral.** A reader may publish an app of its own and name it as the referrer of its own payments, and so pay $(1 - s) \cdot p$. Nothing in the program can tell this from a genuine referral. The publisher's effective price is therefore $(1 - s) \cdot p$, and it should set $p$ and $s$ knowing so. A denial, or a share of zero, removes the incentive.

**Leakage of a referral.** A payment names its subject and its referrer on the ordering. Made under a commitment and through a relayer (§3.2), it does not name the reader, but it reveals that some reader, referred by $r$, paid for $\sigma$. For a record subject, that is which record was bought.

## 3. Security

### 3.1 Confidentiality

The following game fixes a sealed repo $\rho$, a subject $\sigma$ of it, and an epoch $e$. For a record subject, the challenger gives $\mathcal{A}$ every other record's key as well, which by the PRF property of $\mathsf{KDF}$ costs at most $\mathbf{Adv}^{\mathsf{prf}}_{\mathsf{KDF}}$ more below.

$$
\begin{array}{rl}
\hline
& \textbf{Experiment } \mathsf{Conf}^{b}_{\mathcal{A}}(\rho, e) \\
\hline
1: & \mathcal{A} \text{ chooses two states } M_0, M_1 \text{ with } \mathsf{Leak}(M_0) = \mathsf{Leak}(M_1) \\
2: & \text{the challenger seals } M_b \text{ as } \rho\text{'s state in epoch } e\text{, and gives } \mathcal{A} \text{ every public value: } \mathcal{O}\text{, } c_{\sigma,e}\text{, and every sealed node or value} \\
3: & \mathcal{A} \text{ outputs } b' \\
\hline
\end{array}
$$

**Theorem 1 (Conditional confidentiality) [proof].** Let $\mathsf{WE}$ have extractable security, and $\mathsf{SE}$ be DAE-secure. For every efficient $\mathcal{A}$ and polynomial $p$, if

$$
\big|\Pr[\mathsf{Conf}^0_{\mathcal{A}} = 1] - \Pr[\mathsf{Conf}^1_{\mathcal{A}} = 1]\big| \ge 1/p(\lambda) + \mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}
$$

then an efficient extractor, given what $\mathcal{A}$ was given, outputs a witness for $x_{\sigma,e}$ with non-negligible probability.

In words, anyone who learns anything about a sealed state beyond its leakage could have satisfied the condition.

_Proof._ Consider a hybrid in which $c_{\sigma,e}$ encrypts an independent random key instead of $k_\sigma$, the subject's key, $k_{\rho,e}$ or $k_{\rho,e,k}$. In the hybrid, $k_\sigma$ appears only as the key of $\mathsf{SE}$. By DAE security, the sealed nodes of $M_0$ and of $M_1$ are each indistinguishable from random strings of the sizes and repetition pattern that $\mathsf{Leak}$ gives, and these are equal by assumption. So in the hybrid, $\mathcal{A}$'s advantage is at most $\mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}$.

Therefore, if $\mathcal{A}$'s advantage in the real game is at least $1/p(\lambda) + \mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}$, then $\mathcal{A}$, with the rest of its view as auxiliary input, distinguishes $\mathsf{WE}.\mathsf{Enc}(x_{\sigma,e}, k_\sigma)$ from $\mathsf{WE}.\mathsf{Enc}(x_{\sigma,e}, k')$ with advantage at least $1/p(\lambda)$. By extractable security, the extractor outputs a witness for $x_{\sigma,e}$. $\square$

What counts as "could have satisfied the condition" depends on the condition. For payment, anyone who can extend the ordering with a payment can satisfy it, which is the intent: anyone who pays may read. For membership, only those who can produce an enrollment can.

**Proposition 3.1 (The time condition reduces to the clock) [proof sketch].** Let the ordering be timely for $\mathcal{C}$ (Definition 1.3). Suppose $\mathsf{WE}$ is extractable relative to the clock, in the concrete form of [LJKW18, Def. 3], with an extractor that stays in $\mathcal{C}$. Then an adversary in $\mathcal{C}$ that distinguishes a state sealed for time $\tau$, in the game of Theorem 1, with advantage beyond $\mathbf{Adv}^{\mathsf{dae}}_{\mathsf{SE}}$, yields a witness for $\tau$ before the honest clock reaches it, which timeliness rules out.

_Sketch._ The hybrid of Theorem 1 reduces the state to the key $k_{\rho,e}$. On the key, run the extractor. For a computational clock this is [LJKW18, Thm. 3]. What is not written out is how the two pieces compose: the hybrid uses Definition 1.8, while the step on the key needs the concrete form. $\square$

With a signed clock, the time condition can also be met directly: the honest signers attest to the required clock value, which is the committee scheme of §4.3, item 4.

### 3.2 Reader privacy

**Theorem 2 (Reader privacy) [proof].** Decrypting a sealed subject is a local computation on public values. For any two readers that hold witnesses for $x_{\sigma,e}$, the views of all other parties are identical whether either, both or neither of them decrypts.

_Proof._ $\mathsf{WE}.\mathsf{Dec}$ and $\mathsf{SE}.\mathsf{Dec}$ take only the reader's witness and public values, and send nothing. Fetching nodes by name from public hosts is the same for every reader of the repo. $\square$

Reading leaves no trace in the general model. Whatever a reader reveals, it reveals while obtaining its witness: the entries a membership or payment witness requires. Reader privacy therefore reduces to the privacy of those entries. For example, an enrollment or a payment can be made under a commitment to a secret, through a relayer, so that the ordering does not link it to the reader.

---

# Part II — Instantiation

## 4. Practical witness encryption

**The chain as a clock.** A proof-of-work chain is a computational reference clock [LJKW18, §5]: a valid chain of headers that meets a bound on targets is evidence that the corresponding time has passed. The chain of [WP1, §5], taken here to be an EVM rollup, is a **signed** clock (Definition 1.3), not a computational one. Its acceptance rule is the finality of the chain it settles on, together with the rollup's own mechanism for proving or disputing its state, and $\delta$ includes that chain's finality delay, which for a light reader that does not trust the proposer is the rollup's settlement time [WP1, §5]. A light reader can verify it succinctly. A validity proof of the rollup's state against the chain it settles on, together with a proof of that chain's attestations, makes it a succinct clock over a signed one (Definition 1.4). How to build that proof is out of scope (§5).

### 4.1 The ideal and the gap

Practical witness encryption for the relations of §2.1 does not exist. We replace it with an ideal functionality, and realize that functionality with two components.

**Definition 4.1 (Release functionality).** $\mathcal{F}_{\mathsf{rel}}$ holds the keys $k_{\rho,e}$ that publishers deposit. On input a witness $w$ for $x_{\sigma,e}$, it returns $k_{\rho,e}$ if $\sigma = \rho$, and $k_{\rho,e,k}$ if $\sigma = (\rho, k)$. It reveals nothing else.

A system that realizes $\mathcal{F}_{\mathsf{rel}}$ satisfies Theorem 1, with "an extractor outputs a witness" replaced by "the functionality was given a witness". The question is who is trusted to realize it.

### 4.2 Construction: a proof on the chain, and a release scheme

The construction has two components.

**Zero-knowledge proofs of knowledge.** A proof system $\Pi$ for each $R_{\phi_\rho}$ that is zero-knowledge and simulation-extractable (Definition 1.2). Each proof is bound to a message that the verifier computes itself.

**A key-release scheme.** A party, or set of parties, that holds the deposited keys and releases them according to the chain.

The construction runs in three steps.

1. **Seal.** The publisher encrypts the state under $k_{\rho,e}$ as in §2.2, and deposits $k_{\rho,e}$ with the release scheme, in place of publishing $c_{\rho,e}$.
2. **Prove.** A reader with witness $w$ for $x_{\sigma,e}$:
   - generates a fresh key pair $(\mathit{sk}', \mathit{pk}')$;
   - computes a pseudonym $\nu = \mathsf{PRF}(\mathit{sk}, (\sigma, e))$ from the secret in its witness;
   - posts $(x_{\sigma,e}, \mathit{pk}', \nu, \pi)$ to the chain, through a relayer, where $\pi$ proves knowledge of $w$ with $R_{\phi_\rho}(x_{\sigma,e}, w) = 1$ and that $\nu$ is computed correctly.

   The proof is bound to the message $(\sigma, e, \mathit{pk}')$. The chain verifies $\pi$, rejects a pseudonym it has already seen, and records a **grant** $(\sigma, e, \mathit{pk}')$.

3. **Release.** On a grant, the release scheme publishes the subject's key encrypted to $\mathit{pk}'$: $k_{\rho,e}$ for a repo, or $k_{\rho,e,k}$ for a record, which it derives from the deposited $k_{\rho,e}$.

**Theorem 3 (The construction realizes $\mathcal{F}_{\mathsf{rel}}$) [proof sketch].** If $\Pi$ is simulation-extractable and zero-knowledge, the chain satisfies [WP1, Assumption O], and the release scheme releases keys exactly on grants, then the construction realizes $\mathcal{F}_{\mathsf{rel}}$. Moreover:

1. each key reaches only the holder of $\mathit{sk}'$ for a recorded grant;
2. each grant comes with an extractable witness for $x_{\sigma,e}$;
3. the public values of a grant reveal nothing about which witness was used, beyond the condition's anonymity set;
4. a witness yields one grant per $(\sigma, e)$.

_Sketch._

1. Release happens only on a grant, and only to $\mathit{pk}'$.
2. A grant is recorded only for a valid proof whose message the chain fixes. A proof not produced by an honest reader is a proof for a new (statement, message) pair, and simulation extractability yields a witness. Because the message includes $\mathit{pk}'$, a copied proof grants a key the copier does not hold.
3. By zero knowledge, $\pi$ can be simulated from the statement alone, and $\nu$ is a pseudorandom value for a fresh scope.
4. The pseudonym is a function of the witness's secret and $(\sigma, e)$, it is part of the proven statement, and the chain accepts each pseudonym once.

$\square$

### 4.3 Key-release schemes

The construction leaves one component open: who holds the keys. The schemes below differ in who can read every key, and who must be online.

0. **The publisher's own custodian.** Each publisher runs, or has provisioned for it, a custodian that holds only its own keys, and releases them on grants.
   - **Trust:** it can read only what its publisher could already read. A reader trusts it to release on a grant, which is visible if it does not.
   - **Liveness:** the publisher's custodian must be online, for that publisher's data only.
   - The code is that of item 1, so a publisher can later move its keys to item 2 or 3 without resealing anything that has not yet been granted.
1. **A single custodian.** One party holds every key, and releases on grants.
   - **Trust:** it can read every sealed repo, and could release without a grant, undetected.
   - **Liveness:** it must be online.
   - It never learns a reader's witness, and its refusals are visible, because grants are public.
2. **A trusted execution environment.** The custodian runs inside an enclave whose attested code releases only on grants it has verified against the chain itself.
   - **Trust:** nobody reads the keys unless the enclave is broken. Physical attacks on current hardware are known [TEEF25].
   - **Liveness:** the enclave must be online.
3. **A threshold committee.** Keys are encrypted to the tag $(\sigma, e)$ under signature-based witness encryption [MCF24, SWE24], with a committee set up without a dealer [GKPW24, WW26]. Members sign the tag when the chain shows a grant, and $t$ signatures decrypt.
   - **Trust:** no coalition below the threshold can read a key.
   - **Liveness:** any $t$ of the $n$ members suffice.

   This is the closest to the general model. The committee replaces the extractor of Definition 1.8 with an honest-threshold assumption, and nobody holds the keys.

4. **Time alone.** For the time condition, a committee signs each tag when the chain's clock reaches its value. No proof from the reader is needed.

**Curation and keys.** An app that stops citing a sealed record [WP1, §2] stops presenting it, but does not change who may read it: the condition is the subject's, not the app's, and a reader that finds the record elsewhere can still meet it. Withholding keys is a matter for the operator of a release scheme (below).

**Operators.** A custodian or an enclave may refuse to release keys for a subject, on a policy of its own, for example on a lawful notice, and release them again later. Grants are public, so a refusal is visible. Since subjects are repos or records, it can refuse exactly one record, under field sealing, or one repo. Keys already released stay with their holders. A threshold committee refuses only if a threshold of its members do. A publisher that does not accept an operator's policy deposits its keys with another.

In all of them, a reader who receives a key can share it, exactly as a reader who decrypts under true witness encryption can share the plaintext.

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
- **Referral (§2.4).** That a curator share pays for curation is argued, not proven, and self-referral lowers the effective price to $(1 - s) \cdot p$.
- **Field sealing (§2.2).** What a record's public fields reveal about its sealed ones is the publisher's choice, and is not analysed. A thumbnail is a copy of an image at low resolution, and an embedding can be partly inverted.
- **Clock skew (§3.1).** With the chain's timestamps as the clock [WP1, §5], a proposer can set them ahead within their skew bound, and so meet a time condition early by up to that bound. The bound is assumed. A deployment that cannot accept it can state time conditions in block heights.

This document omits the following, each of which builds on it:

- how to build a succinct clock for the chain of [WP1, §5];
- the construction of anonymous payment;
- how the revenue of a bundle (§2.1) is shared among the publishers in it, for example in proportion to the number of members each epoch;
- releasing a function of sealed values rather than a key, so that an app can index what it has not bought (§2.3);
- the policies of operators (§4.3), and their legal obligations;
- cumulative access to earlier epochs through key regression [FKK06];
- how point reads and the fraud proofs of [WP1, Appendix C] apply to sealed slices;
- where the grant and enrollment programs live relative to the registry, beyond naming $\iota$;
- the cost of committing again under a new epoch, after a late update [WP1, §3.2], which re-encrypts every node of the state under the new key.

## References

| Key       | Reference                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [BBBF18]  | D. Boneh, J. Bonneau, B. Bünz, B. Fisch. Verifiable Delay Functions. CRYPTO 2018 (ePrint 2018/601, version of 26 June 2019)                                         |
| [FKK06]   | K. Fu, S. Kamara, T. Kohno. Key Regression: Enabling Efficient Key Distribution for Secure Distributed Storage. NDSS 2006                                           |
| [GGHW14]  | S. Garg, C. Gentry, S. Halevi, D. Wichs. On the Implausibility of Differing-Inputs Obfuscation and Extractable Witness Encryption with Auxiliary Input. CRYPTO 2014 |
| [GGSW13]  | S. Garg, C. Gentry, A. Sahai, B. Waters. Witness Encryption and Its Applications. STOC 2013                                                                         |
| [GKPVZ13] | S. Goldwasser, Y. T. Kalai, R. A. Popa, V. Vaikuntanathan, N. Zeldovich. How to Run Turing Machines on Encrypted Data. CRYPTO 2013                                  |
| [GKPW24]  | S. Garg, D. Kolonelos, G.-V. Policharla, M. Wang. Threshold Encryption with Silent Setup. CRYPTO 2024                                                               |
| [LJKW18]  | J. Liu, T. Jager, S. A. Kakvi, B. Warinschi. How to Build Time-Lock Encryption. Designs, Codes and Cryptography, 2018                                               |
| [MCF24]   | N. Döttling, L. Hanzlik, B. Magri, S. Wohnig. McFly: Verifiable Encryption to the Future Made Practical. FC 2024                                                    |
| [RS06]    | P. Rogaway, T. Shrimpton. Deterministic Authenticated-Encryption. Eurocrypt 2006                                                                                    |
| [SWE24]   | G. Avitabile, N. Döttling, B. Magri, C. Sakkas, S. Wohnig. Signature-based Witness Encryption with Compact Ciphertext. Asiacrypt 2024                               |
| [TEEF25]  | TEE.Fail, October 2025                                                                                                                                              |
| [WP1]     | driemworks. Fangorn I: Verifiable Data without a Platform. Working draft, 2026-10-13                                                                                |
| [WW26]    | B. Waters, D. J. Wu. Silent Threshold Cryptography from Pairings. Eurocrypt 2026                                                                                    |
| [ZUB19]   | S. Zuboff. The Age of Surveillance Capitalism. 2019                                                                                                                 |
