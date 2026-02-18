import { AgentCard } from "@a2a-js/sdk";

export class AgentCardBuilder {
	private card: Partial<AgentCard> = {
		capabilities: {
			streaming: false,
			pushNotifications: false,
			stateTransitionHistory: false,
		},
		defaultInputModes: ["text/plain", "application/json"],
		defaultOutputModes: ["text/plain", "application/json"],
		skills: [],
	};

	name(name: string): this {
		this.card.name = name;
		return this;
	}

	description(description: string): this {
		this.card.description = description;
		return this;
	}

	version(version: string): this {
		this.card.version = version;
		return this;
	}

	url(url: string): this {
		this.card.url = url;
		return this;
	}

	protocolVersion(protocolVersion: string): this {
		this.card.protocolVersion = protocolVersion;
		return this;
	}

	capabilities(opts: {
		streaming?: boolean;
		pushNotifications?: boolean;
		stateTransitionHistory?: boolean;
	}): this {
		this.card.capabilities = { ...this.card.capabilities, ...opts };
		return this;
	}

	streaming(enabled = true): this {
		this.card.capabilities = { ...this.card.capabilities, streaming: enabled };
		return this;
	}

	pushNotifications(enabled = true): this {
		this.card.capabilities = {
			...this.card.capabilities,
			pushNotifications: enabled,
		};
		return this;
	}

	stateTransitionHistory(enabled = true): this {
		this.card.capabilities = {
			...this.card.capabilities,
			stateTransitionHistory: enabled,
		};
		return this;
	}

	inputModes(modes: string[]): this {
		this.card.defaultInputModes = modes;
		return this;
	}

	outputModes(modes: string[]): this {
		this.card.defaultOutputModes = modes;
		return this;
	}

	addSkill(
		id: string,
		name: string,
		description: string,
		tags: string[],
		examples?: string[],
	): this {
		const skill: {
			id: string;
			name: string;
			description: string;
			tags: string[];
			examples?: string[];
		} = {
			id,
			name,
			description,
			tags,
		};
		if (examples) skill.examples = examples;
		this.card.skills!.push(skill);
		return this;
	}

	provider(organization: string, url: string): this {
		this.card.provider = { organization, url };
		return this;
	}

	documentationUrl(url: string): this {
		this.card.documentationUrl = url;
		return this;
	}

	build(): AgentCard {
		const required = ["name", "description", "version", "url"] as const;
		for (const field of required) {
			if (!this.card[field]) {
				throw new Error(`AgentCard requires '${field}'`);
			}
		}
		return this.card as AgentCard;
	}
}

export const agentCardBuilder = () => new AgentCardBuilder();

// export const datasourceAgentCards: AgentCard[] = [
//   agentCard()
//     .name("MCP Entertainment Data Agent")
//     .description("An MCP server that provides game and music lookup tools.")
//     .version("1.0.0")
//     .url("http://localhost:3001/mcp")
//     .addSkill("find-game", "Find Game", "Finds a video game by name.", ["games", "search", "mcp"])
//     .addSkill("find-music", "Find Music", "Finds a song by name.", ["music", "search", "mcp"])
//     .provider("Fangorn", "https://x402.fangorn.network")
//     .build(),

//   agentCard()
//     .name("Game Data Source Agent")
//     .description("A REST based agent that provides the latest video game data.")
//     .version("1.0.0")
//     .url("http://localhost:3000/games")
//     .addSkill("obtain-x402f", "Obtain x402f", "Calling the agent via REST will result in the appropriate x402f response.", ["datasource", "games", "rest", "x402f"])
//     .provider("Fangorn", "https://x402.fangorn.network")
//     .build(),

//   agentCard()
//     .name("Coleman hello.txt provider")
//     .description("A REST based agent that provides the hello world text files.")
//     .version("1.0.0")
//     .url("http://localhost:4021/resource")
//     .addSkill("obtain-x402f", "Obtain x402f", "Calling the agent via REST will result in the appropriate x402f response.", ["datasource", "hello", "world", "helloworld", "rest", "x402f"])
//     .provider("Fangorn", "https://x402.fangorn.network")
//     .build(),
// ];

// export const fangornDatasourceCard: AgentCard =
//      agentCard()
//     .name("Coleman hello.txt provider")
//     .description("A REST based agent that provides the hello world text files.")
//     .version("1.0.0")
//     .url("http://localhost:4021/resource")
//     .addSkill("obtain-x402f", "Obtain x402f", "Calling the agent via REST will result in the appropriate x402f response.", ["datasource", "hello", "world", "helloworld", "rest", "x402f"])
//     .provider("Fangorn", "https://x402.fangorn.network")
//     .build();

// console.log(JSON.stringify(fangornDatasourceCard))
