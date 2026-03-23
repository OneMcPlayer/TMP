import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import RehearsalPage from "@/pages/rehearsal";

function App() {
  return (
    <TooltipProvider>
      <Toaster />
      <RehearsalPage />
    </TooltipProvider>
  );
}

export default App;
