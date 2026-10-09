import { requireChatGPTUser } from "./chatgpt-auth";
import { StoreLaunchApp } from "./store-launch-app";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireChatGPTUser("/");
  return <StoreLaunchApp />;
}
