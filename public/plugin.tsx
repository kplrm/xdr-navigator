import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import type { AppMountParameters, CoreSetup, CoreStart, Plugin, SIDECAR_DOCKED_MODE } from '../../OpenSearch-Dashboards/src/core/public';
import { Api } from './api';
import { NavigatorApp } from './ui';
import './styles.scss';

const PREFIX = 'xdr-navigator-state:';
interface UiState { open: boolean; conversationId?: string }
function readState(key: string): UiState {
  try { return JSON.parse(window.localStorage.getItem(key) || '{"open":false}') as UiState; }
  catch { return { open: false }; }
}

export class XdrNavigatorPlugin implements Plugin<Record<string, never>, Record<string, never>> {
  private core?: CoreStart;
  private sidecar?: { close: () => Promise<void>; onClose: Promise<void> };
  private sidecarRoot?: Root;
  private buttonRoot?: Root;
  private channel?: BroadcastChannel;
  private state: UiState = { open: false };
  private storageKey?: string;

  public setup(core: CoreSetup) {
    core.application.register({
      id: 'xdrNavigator', title: 'Navigator', order: 3,
      category: { id: 'xdrSecurity', label: 'XDR Security', order: 2200 },
      mount: async (params: AppMountParameters) => {
        const [start] = await core.getStartServices();
        const root = createRoot(params.element);
        root.render(<NavigatorApp api={new Api(start)} mode="page" onSelectChat={(id) => { this.setConversation(id); this.open(); }} />);
        return () => root.unmount();
      },
    });
    return {};
  }

  public start(core: CoreStart) {
    this.core = core;
    core.chrome.navControls.registerRight({
      order: 900,
      mount: (element) => {
        this.buttonRoot = createRoot(element);
        this.renderButton();
        return () => { this.buttonRoot?.unmount(); this.buttonRoot = undefined; };
      },
    });
    void new Api(core).session().then(({ user }) => {
      this.storageKey = `${PREFIX}${user.id}`;
      this.state = readState(this.storageKey);
      this.channel = new BroadcastChannel(this.storageKey);
      this.channel.onmessage = (event: MessageEvent<UiState>) => this.sync(event.data);
      window.addEventListener('storage', this.onStorage);
      if (this.state.open) this.open(false);
      this.renderButton();
    }).catch(() => this.renderButton());
    return {};
  }

  private onStorage = (event: StorageEvent) => {
    if (this.storageKey && event.key === this.storageKey) this.sync(readState(this.storageKey));
  };

  private sync(next: UiState) {
    if (next.conversationId !== this.state.conversationId) {
      this.state.conversationId = next.conversationId;
      this.renderSidecar();
    }
    if (next.open && !this.sidecar) this.open(false);
    if (!next.open && this.sidecar) this.close(false);
    this.state.open = next.open;
    this.renderButton();
  }

  private write() {
    if (!this.storageKey) return;
    window.localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    this.channel?.postMessage(this.state);
  }

  private setConversation(id?: string) {
    this.state.conversationId = id;
    this.write(); this.renderSidecar();
  }

  private renderButton() {
    this.buttonRoot?.render(<button className="xdrNavHeaderButton" onClick={() => this.sidecar ? this.close() : this.open()}>
      ✦ XDR AI Agent
    </button>);
  }

  private renderSidecar() {
    if (!this.sidecarRoot || !this.core) return;
    this.sidecarRoot.render(<NavigatorApp api={new Api(this.core)} mode="sidecar" initialConversationId={this.state.conversationId} onSelectChat={(id) => this.setConversation(id)} onClose={() => this.close()} />);
  }

  private open(broadcast = true) {
    if (!this.core || this.sidecar) return;
    this.sidecar = this.core.overlays.sidecar.open((element) => {
      this.sidecarRoot = createRoot(element);
      this.renderSidecar();
      return () => { this.sidecarRoot?.unmount(); this.sidecarRoot = undefined; };
    }, { className: 'xdrNavigatorSidecar', config: { dockedMode: 'right' as SIDECAR_DOCKED_MODE, paddingSize: 520 } });
    const ref = this.sidecar;
    void ref.onClose.then(() => {
      if (this.sidecar === ref) { this.sidecar = undefined; this.state.open = false; this.write(); this.renderButton(); }
    });
    this.state.open = true;
    if (broadcast) this.write();
    this.renderButton();
  }

  private close(broadcast = true) {
    const ref = this.sidecar;
    this.sidecar = undefined;
    void ref?.close();
    this.state.open = false;
    if (broadcast) this.write();
    this.renderButton();
  }

  public stop() {
    this.close(false);
    this.channel?.close();
    window.removeEventListener('storage', this.onStorage);
  }
}
