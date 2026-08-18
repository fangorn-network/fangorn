What if instead of publisher terms being mapped to a hash + uri, it was insteads something that must exist in fangorn?

We could have an app registered, call it... app-terms, which would allow app owners, acting as publishers, to publish their terms sheets to Fangorn. This app itself can be indexed via quickbeam to make the app registry searchable and discoverable.

Let's suppose we have an 'apps' namespace that's reserved by the system.
This let's us own the app registry in its entirety.

The flow would look like
1. $\{\perp, ()\} \leftarrow DataRegistry.RegisterPublisher()$ => should they have to stake something? how do we hold publishers accountable?
2. $\{\perp, ()\} \leftarrow AppRegistry.RegisterApp(appId)$   => should this be free? maybe, there could be tiers
    On RegisterApp => you are automatically the first registered publisher

    - this is where they would determine if they want to pay for quickbeam and storage and such
    - so maybe the subscription registry should actually be folded in here somewhat?
3. Publish ToS to Fangorn app space, where you are authorized to do so only for your own app
    // this isn't precise notation, very brainstormy
    DataRegisty.commit_state_root(root(G=(ToS, ()) <- a singleton graph), appId)

    - this makes changes to the ToS auditable and transparent
    - The publisher publishes to: apps:0xYourAddr:appId:terms
    - this would need to be automated from the fangorn.network acct management panel for sure. 
4. Then, when a publisher wants to register in the app they first fetch the ToS, get the hash, and then sign it
    DataRegistry.RegisterPublisher()
    ToS <- fangorn.get(apps:0xwallet:appId:terms)
    H <- sha256(ToS)
    sig <- sign(sk, H)
    RegisterPublisherForApp(sig)



---

App Registration

Let $W = (sk, pk = g*sk)$ be the wallet keys for some app owner $A$.
Let $appId \in \{0, 1\}^{32}$ be a 32 byte app id that uniquely identifies an app owned by $A$, $\mathcal{A}$.

Let $T \in \{0, 1\}^*$ be the terms and conditions that must be agreed upon in order to act as a publisher who can write to the application. That is, without agreeing, no party can publish data through the app. These terms are legally binding.

First, we formally model the App Registry **contract state** as the family of functions evaluated at some block number $b$:

$$
\begin{align}
State(C_A, b) = (\\
  &admin, \\
  &\alpha_b: \{0,1\}^{32} \to \{0,1\}^{32}, \\
  &t_b: \{0,1\}^{32} \to \{0,1\}^{32}, \\
  &\hat{t}_b: \{0,1\}^{32} \to \{0,1\}^{*}), \\
  &f_b: \{0,1\}^{32} \to \{0,1\}^{256}, \\
  &stats_b: \{0,1\}^{32} \to \{0,1\}^{2}, \\
  &acc_b: \{0,1\}^{32} \to \{0,1\}^{32}
 \\ )
\end{align}
$$

## Functions (state mutations)

#### Register App

Given a contract state $State(C_A, b)$ at some block number $b$, $R(a \in \{0,1\}^{32}, t \in \{0,1\}^{32}, \hat{t} \in \{0,1\}^{32}, \in \{0,1\}^*, f \in \{0,1\}^{256})$ mutates the state to $State(C_A, b+1) |_R$* as follows:

$$
\begin{align}
& if \; \alpha_b(a) \neq \empty, ABORT \\
&\alpha_{b+1} = \alpha_b \cup \{a \to A\} \\
&t_{b+1} = t_b \cup \{a \to t\} \\
&\hat{t}_{b+1} = \hat{t}_b \cup \{a \to \hat{t}\} \\
&f_{b+1} = f_b \cup \{a \to f\}
\end{align}
$$

> *: By $A |_R$, we mean the state $A$ filtered to only the parts modified as a result of the transformation $R$.

#### Register As a Publisher
