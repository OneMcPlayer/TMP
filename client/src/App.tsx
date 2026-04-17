import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getCurrentAppRoute } from "@/lib/app-route";
import AudioLabPage from "@/pages/audio-lab";
import RealtimeCallLabPage from "@/pages/realtime-call-lab";
import RehearsalPage from "@/pages/rehearsal";
import { useEffect, useState } from "react";

function App() {
  const [route, setRoute] = useState(getCurrentAppRoute);

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(getCurrentAppRoute());
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  return (
    <TooltipProvider>
      <Toaster />
      {route === "audio-lab" ? (
        <AudioLabPage />
      ) : route === "realtime-lab" ? (
        <RealtimeCallLabPage />
      ) : (
        <RehearsalPage />
      )}
    </TooltipProvider>
  );
}

export default App;
