# Backing: markets for data revenue

_Design note, exploratory. Nothing here is built or decided, and the legal
questions in §7 are open. Not legal advice._

## 1. The idea

A repo's owner can sell shares of its future income. Anyone can buy them,
hold them, and trade them. A share pays out when the repo earns, and only
then.

Backers are a role distinct from publishers, consumers and apps. They don't
produce data, buy data, or validate anything: they bet on which repos agents
will buy from, and are paid when agents do. Running a scout, a program that
watches public signals and backs repos, is the "download, run, earn" form of
the role.

What backing gives the rest of the network:

- **Publishers get capital early**: an advance on earnings, before they have a
  sales record.
- **Agents get a quality signal**: backing junk earns nothing, so where backers
  put money says something. Agents may weigh it; the protocol never does (§3).
- **Demand gets amplified**: backers fund supply where they expect demand.
  They do not create demand. Without buyers, shares pay nothing.

## 2. Parties

| Party                                         | Does                          | Paid by                                                 | Sees backers                         |
| --------------------------------------------- | ----------------------------- | ------------------------------------------------------- | ------------------------------------ |
| Consumer (a person or their agent)            | Pays per read over x402       | —                                                       | Never. The price is the publisher's. |
| Publisher (a repo of its own records)         | Publishes records, sets terms | Its sales; optionally, an advance                       | Only as an offer of an advance       |
| App (a repo citing other publishers' records) | Curates, routes buyers        | Referral on the sales it routes; optionally, an advance | Only as an offer of an advance       |
| Backer                                        | Buys and trades repo shares   | The share of income it holds                            | Everything                           |
| Protocol                                      | Settles sales, records shares | A fee, if any                                           | —                                    |

Producers and consumers never deal with backers. A publisher's whole
experience of backing is choosing to sell part of its income for money now.

## 3. Invariants

1. **Backing never changes what a buyer pays.** The price is set by the
   record's terms, never by a market in shares.
2. **Every payout comes from buyer money.** No emissions, no inflation, no
   subsidy funded by new backers.
3. **Backing never grants access.** A share is a claim on income, not a
   licence to read. Access stays a payment per read, licensed to the buyer
   and not transferable.
4. **Share prices never rank.** No protocol component uses share price or
   backing volume to order results. An agent may weigh it locally, under its
   principal's policy.

The first three separate the three things a data protocol tends to fuse:
access, a claim on revenue, and a signal of value. Where earlier projects
fused them, the failures were predictable:

- **Access as a traded asset** (Ocean's datatokens): buyers pay a speculator's
  price to read, and the data's price follows the pool, not its use.
- **Yield from emissions** (Vana, Audius, in different ways): payouts come from
  inflation rather than buyers, so token value drifts from real use.

The fourth keeps backing out of discovery: bought rank is paid placement.

## 4. Shares

A share is a claim on a fixed fraction of one repo's income, from the block it
is issued onward.

- **A publisher's shares** cover its own sales.
- **An app's shares** cover only its referral income. An app does not own the
  revenue of the publishers it cites.

So there are two kinds of bet: on a producer's data, and on a curator's taste
and reach. A sale through an app pays both kinds of shareholder, out of
different cuts, and pays none twice.

Shares are transferable. The market prices how early a backer is: shares in a
repo with no sales record are cheap and rise as sales appear. The protocol
adds no time-weighting.

A share covers income, not work. A publisher who stops publishing owes
nothing more; its backers priced that risk when they bought.

## 5. The split

Each sale is cut in a fixed order:

1. **Protocol fee**, if any.
2. **Referral**, to the app that routed the sale, if any.
3. **The publisher's remainder**, of which the shares the publisher has issued
   take their fraction, pro rata to holders.

The referral (step 2) is in turn split between the app and its shareholders.

Example: a $1.00 sale with a 1% fee, routed through an app taking 10% of what
remains as referral. The app has sold 20% of its income, the publisher 30%.

| Recipient                | Amount  |
| ------------------------ | ------- |
| Protocol                 | $0.0100 |
| App                      | $0.0792 |
| App's shareholders       | $0.0198 |
| Publisher                | $0.6237 |
| Publisher's shareholders | $0.2673 |

## 6. Standard terms

An owner sells rights as it pleases, within terms every share states the same
way, so a backer can compare any two:

- **Fraction**: what part of income the issue covers.
- **Scope**: own sales, referral, or both.
- **Dilution**: whether the owner may issue more later, and up to what total.
- **Start**: the block the claim covers income from.
- **Issuer**: the repo owner's identity, and any credential it holds (§7).

Shares are another signed term, like a record's licence, so they inherit the
same machinery for terms.

## 7. Regulation

In the US, a transferable share of an enterprise's revenue, bought for profit
from the owner's work, is very likely a security. Recording it on chain does
not change that. Selling securities is legal through an exemption or
registration, and each route has costs:

- **Investors are verified.** KYC and AML fall on backers, not only issuers,
  and some routes cap what each investor may put in.
- **Resale is restricted.** Some exemptions lock shares for a period; trading
  after that needs a registered venue, not a permissionless pool.
- **Issuers are identified.** Publishers who sell shares go through KYC.
  Publishers who don't sell shares need not.

Event contracts on a repo's sales ("will repo X earn $Y by date Z") are
regulated too, by a different agency. No form of this is unregulated in the US;
the choice is which regime.

The likely shape: anyone, anywhere, publishes and consumes as now. Issuing
shares requires identity. Backers reach shares through a compliant venue in
the US, and under their own jurisdiction's rules elsewhere.

## 8. Attacks

- **Wash trading.** A publisher buying its own records pays its shareholders'
  fraction to them: washing transfers money to other backers. It pays only
  where the publisher holds most of its own shares. A protocol fee makes it
  cost money even then.
- **Pump and dump.** Buying shares to attract attention costs real money, lost
  if no sales follow, and buys no rank (invariant 4).
- **Issue and abandon.** Sell shares, then stop publishing. Shares cover income,
  not work, so this is priced, not fraud. Dilution terms stop the variant
  where an owner issues without limit.

## 9. Install and earn

Every party reaches the network through one MCP server, installed in an AI
client (Claude first). Everything else is invisible: no chain, repo or licence
shows unless the person looks for it.

| Mode          | The person sees                                               | Underneath                                                        |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Publish       | Their agent proposes "worth selling, at $0.05?"; they say yes | A record in their repo, with signed terms and an x402 price       |
| Curate        | Their agent keeps lists of good finds                         | An app: a repo of citations, paid referral on the sales it routes |
| Spend         | Better answers, within a monthly budget they set              | Discovery ranks publishers; the agent pays per read               |
| Back (opt-in) | Scout mode: their agent backs repos it expects to sell        | Repo shares (§4)                                                  |

Sign-in is an email; the wallet is embedded; payouts arrive in dollars.

Every installer is on both sides: the person who publishes also buys, through
their agent. Supply and demand grow together, and the protocol's fee rides the
flow between them.

Rules:

1. **Nothing is published without a yes.** The agent proposes; the person
   decides, item by item.
2. **Spending is capped, and every purchase leaves a receipt** the person can
   see.
3. **The agent's ranking is not for sale.** Invariant 4, applied to the agent
   that shops.

Earnings follow a power law: most installers earn little, and a few whose work
others need earn real money. Finding those few early is what backers are paid
for.

## 10. Open questions

1. **Dilution.** Whether an issue's terms may allow later issues, and how a
   backer sees the total.
2. **A surface for demand.** Shares resolve on recorded sales, a lagging
   signal. A leading one would be buyers posting bounties for data they want,
   but published intents leak what people are looking for. If built, it should
   be opt-in and anonymous.
3. **The first buyers.** Backing amplifies demand that exists. Until outside
   buyers arrive, the network's own surfaces are the buyers, and should be
   counted as such.
4. **Regulatory route.** Which exemption, which venue, which jurisdictions
   first.
