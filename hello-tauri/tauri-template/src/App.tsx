import { Box, Flex } from "@mantine/core";
import { Sampler } from "./sampler";
import { Sidebar } from "./sidebar";

function App() {
  return (
    <Flex p="md" gap="md" style={{ height: '100vh' }}>
      <Box>
        <Sidebar />
      </Box>

      <Box style={{ flex: 1 }}>
        <Sampler />
      </Box>
    </Flex>
  );
}

export default App;
