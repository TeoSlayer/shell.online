class ShellOnline < Formula
  desc "Turn any terminal process into an interactive browser link"
  homepage "https://shell.online"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/TeoSlayer/shell.online/releases/download/v0.3.9/shell-darwin-arm64"
      sha256 "e87de68ca81a6f45a864a857dc1d8ab247e73005a10a7011efe2c031a30f4ad3"
    end

    on_intel do
      url "https://github.com/TeoSlayer/shell.online/releases/download/v0.3.9/shell-darwin-amd64"
      sha256 "c041598316704773130586017ae0d9424d3c4278d24d9f731626a0079b82d7b0"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/TeoSlayer/shell.online/releases/download/v0.3.9/shell-linux-arm64"
      sha256 "31210b91f829595c559065959c00f0537f6eb06135602fcf27215118b5166ed6"
    end

    on_intel do
      url "https://github.com/TeoSlayer/shell.online/releases/download/v0.3.9/shell-linux-amd64"
      sha256 "321f57d16199adcae6f94aeb48d10ece232fbf08815d04d3a446369702f6b6c4"
    end
  end

  def install
    platform = OS.mac? ? "darwin" : "linux"
    architecture = Hardware::CPU.arm? ? "arm64" : "amd64"
    binary = "shell-#{platform}-#{architecture}"

    chmod 0755, binary
    bin.install binary => "shell"
  end

  test do
    assert_equal "shell #{version}\n", shell_output("#{bin}/shell --version")
    assert_match "shell.online", shell_output("#{bin}/shell help")
  end
end
