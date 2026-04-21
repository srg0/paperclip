import { useEffect, useMemo, useState } from "react";
import type { Agent, Issue, LiveEvent } from "@paperclipai/shared";
import { useLiveUpdates } from "../context/LiveUpdatesProvider";
import {
  normalizeIssueChatLiveEvent,
  type IssueChatLiveFeedItem,
  type IssueChatLiveSignal,
} from "../lib/issue-chat-live-transport";

interface UseIssueChatLiveTransportOptions {
  companyId?: string | null;
  issue?: Pick<Issue, "id" | "identifier"> | null;
  agents?: Agent[] | null;
  maxFeedItems?: number;
}

export function useIssueChatLiveTransport({
  companyId,
  issue,
  agents,
  maxFeedItems = 10,
}: UseIssueChatLiveTransportOptions) {
  const { subscribe } = useLiveUpdates();
  const [signal, setSignal] = useState<IssueChatLiveSignal | null>(null);
  const [feed, setFeed] = useState<IssueChatLiveFeedItem[]>([]);
  const issueKey = useMemo(() => `${issue?.id ?? "none"}:${issue?.identifier ?? "none"}`, [issue?.id, issue?.identifier]);

  useEffect(() => {
    setSignal(null);
    setFeed([]);
  }, [issueKey]);

  useEffect(() => {
    if (!companyId || !issue?.id) return;

    return subscribe((event: LiveEvent) => {
      if (event.companyId !== companyId) return;

        const update = normalizeIssueChatLiveEvent({
          event,
          issue,
          agents,
        });
        if (!update) return;

        const nextSignal = update.signal;
        if (nextSignal) {
          setSignal((current) => {
            if (!current) return nextSignal;
            return new Date(nextSignal.updatedAt).getTime() >= new Date(current.updatedAt).getTime()
              ? nextSignal
              : current;
          });
        }

        const nextFeedItem = update.feedItem;
        if (nextFeedItem) {
          setFeed((current) => {
            if (current.some((item) => item.key === nextFeedItem.key)) return current;
            return [nextFeedItem, ...current].slice(0, maxFeedItems);
          });
        }
      });
  }, [agents, companyId, issue, maxFeedItems, subscribe]);

  return {
    signal,
    feed,
  };
}
