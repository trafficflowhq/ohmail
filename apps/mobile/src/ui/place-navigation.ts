import { router, useNavigation, type Href } from "expo-router";
import { Platform } from "react-native";

export interface PlaceNavigation {
  getState(): { type: string; key: string; routeNames: readonly string[] } | undefined;
  dispatch(action: { type: "PUSH"; target: string; payload: { name: string } }): void;
}

export function usePushMailPlace() {
  const current = useNavigation();
  return (path: Href, navigation: PlaceNavigation = current) => {
    const name = path === "/search" ? "search" : path === "/settings" ? "settings" : null;
    if (name !== null && Platform.OS === "android") {
      const stack = navigation.getState();
      if (stack?.type === "stack" && stack.routeNames.includes(name)) {
        // The route is already known. Dispatch in the same event as the dock or drawer update.
        navigation.dispatch({ type: "PUSH", target: stack.key, payload: { name } });
        return;
      }
    }
    router.push(path);
  };
}
