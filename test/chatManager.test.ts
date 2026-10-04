import { expect } from "chai";
import { ChatManager } from "../src/modules/hermes/ChatManager";
import type { Conversation } from "../src/modules/hermes/ConversationManager";
import type { ChatMessage } from "../src/views/types";
import type Addon from "../src/addon";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_1",
    title: "Test",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    allowedTools: null,
    ...overrides,
  };
}

/** Build an addon whose conversations manager is a spy. */
function makeAddon() {
  const saved: Conversation[] = [];
  const conversations = {
    getCurrentConversation: () => saved[saved.length - 1] || null,
    saveConversation: (conv: Conversation) => {
      saved.push(conv);
    },
    clearMessages: () => {
      saved.length = 0;
    },
  };
  const addon = {
    data: { hermes: { conversations } },
    log: () => {},
  } as unknown as Addon;
  return { addon, conversations, saved };
}

describe("ChatManager", function () {
  it("should add messages and return a copy of the array", function () {
    const { addon } = makeAddon();
    const manager = new ChatManager(addon);
    manager.addMessage(makeMessage({ id: "a" }));
    manager.addMessage(makeMessage({ id: "b", role: "assistant" }));

    const messages = manager.getMessages();
    expect(messages).to.have.length(2);
    // Pushing to the returned array must not affect internal state
    messages.push(makeMessage({ id: "c" }));
    expect(manager.getMessages()).to.have.length(2);
  });

  it("should flush pending saves immediately", function () {
    const { addon, saved } = makeAddon();
    const manager = new ChatManager(addon);
    const conv = makeConversation();
    saved.push(conv);

    manager.addMessage(makeMessage({ id: "a" }));
    manager.flush();

    expect(saved[saved.length - 1].messages).to.have.length(1);
    expect(saved[saved.length - 1].messages[0].id).to.equal("a");
  });

  it("should clear messages and flush immediately", function () {
    const { addon, saved } = makeAddon();
    const manager = new ChatManager(addon);
    const conv = makeConversation();
    saved.push(conv);

    manager.addMessage(makeMessage({ id: "a" }));
    manager.clearMessages();

    expect(manager.getMessages()).to.have.length(0);
    expect(saved).to.have.length(0);
  });

  it("should load messages from a conversation", function () {
    const { addon } = makeAddon();
    const manager = new ChatManager(addon);
    const conv = makeConversation({
      messages: [makeMessage({ id: "x" })],
    });
    manager.loadFromConversation(conv);
    expect(manager.getMessages()).to.have.length(1);
    expect(manager.getMessages()[0].id).to.equal("x");
  });

  it("should set messages and schedule a save", function () {
    const { addon, saved } = makeAddon();
    const manager = new ChatManager(addon);
    const conv = makeConversation();
    saved.push(conv);

    manager.setMessages([makeMessage({ id: "z" })]);
    manager.flush();

    expect(saved[saved.length - 1].messages).to.have.length(1);
    expect(saved[saved.length - 1].messages[0].id).to.equal("z");
  });

  it("should dispatch external prompts with optional context to listeners", function () {
    const { addon } = makeAddon();
    const manager = new ChatManager(addon);
    const received: Array<{ prompt: string; items?: unknown }> = [];
    const unsubscribe = manager.onExternalPrompt((prompt, contextItems) => {
      received.push({ prompt, items: contextItems });
    });

    manager.dispatchExternalPrompt("hello");
    manager.dispatchExternalPrompt("world", [
      { id: "item-1", type: "item", text: "T" },
    ]);

    expect(received).to.have.length(2);
    expect(received[0].prompt).to.equal("hello");
    expect(received[0].items).to.be.undefined;
    expect(received[1].prompt).to.equal("world");
    expect(received[1].items).to.have.length(1);

    unsubscribe();
    manager.dispatchExternalPrompt("ignored");
    expect(received).to.have.length(2);
  });

  it("should not let one failing listener break the others", function () {
    const { addon } = makeAddon();
    const manager = new ChatManager(addon);
    let secondCalled = false;
    manager.onExternalPrompt(() => {
      throw new Error("boom");
    });
    manager.onExternalPrompt(() => {
      secondCalled = true;
    });
    manager.dispatchExternalPrompt("x");
    expect(secondCalled).to.be.true;
  });

  it("should buffer prompts dispatched before any subscriber exists", function () {
    const { addon } = makeAddon();
    const manager = new ChatManager(addon);

    // Subscriber arrives late — this is the sidebar-mount race.
    const reached = manager.dispatchExternalPrompt("early prompt", [
      { id: "item-1", type: "item", text: "T" },
    ]);
    expect(reached).to.equal(0);

    const received: Array<{ prompt: string; items?: unknown }> = [];
    manager.onExternalPrompt((prompt, contextItems) => {
      received.push({ prompt, items: contextItems });
    });

    // The buffered prompt is replayed on subscription, not dropped.
    expect(received).to.have.length(1);
    expect(received[0].prompt).to.equal("early prompt");
    expect(received[0].items).to.have.length(1);
  });

  it("should replay buffered prompts only once", function () {
    const { addon } = makeAddon();
    const manager = new ChatManager(addon);
    manager.dispatchExternalPrompt("once");

    let first = 0;
    manager.onExternalPrompt(() => {
      first += 1;
    });
    expect(first).to.equal(1);

    // A second subscriber must not receive the already-replayed prompt.
    let second = 0;
    manager.onExternalPrompt(() => {
      second += 1;
    });
    expect(second).to.equal(0);
  });

  it("should report the number of subscribers reached when delivered", function () {
    const { addon } = makeAddon();
    const manager = new ChatManager(addon);
    manager.onExternalPrompt(() => {});
    manager.onExternalPrompt(() => {});
    expect(manager.dispatchExternalPrompt("now")).to.equal(2);
  });

  it("should clear the buffer once a subscriber has consumed it", function () {
    const { addon } = makeAddon();
    const manager = new ChatManager(addon);
    manager.dispatchExternalPrompt("a");
    manager.onExternalPrompt(() => {});
    // Buffer drained — a subsequent subscribe before any new dispatch
    // must not replay the old prompt again.
    let calls = 0;
    manager.onExternalPrompt(() => {
      calls += 1;
    });
    expect(calls).to.equal(0);
  });
});
