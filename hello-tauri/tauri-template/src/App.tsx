import { Box, Flex } from "@mantine/core";
import { Sampler } from "./sampler";
import { Sidebar } from "./sidebar";

function App() {
  return (
    <Flex style={{ height: '100vh' }}>
      <Box>
        <Sidebar />
      </Box>

      <Box style={{ flex: 1 }} p="md">
        <Sampler />
      </Box>
    </Flex>
  );
}

export default App;
