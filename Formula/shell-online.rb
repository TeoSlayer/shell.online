class ShellOnline < Formula
  desc "Turn any terminal process into an interactive browser link"
  homepage "https://shell.online"
  url "https://github.com/TeoSlayer/shell.online/archive/refs/tags/v0.3.9.tar.gz"
  sha256 "75c671d195d3acb3604d8fe5adf8a962ea94a609de86aff145484c2ab4810908"
  license "MIT"

  depends_on "go" => :build

  def install
    ENV["CGO_ENABLED"] = "0"
    ldflags = "-X main.version=#{version}"
    system "go", "build", *std_go_args(output: bin/"shell", ldflags:), "./cmd/shell"
  end

  test do
    assert_equal "shell #{version}\n", shell_output("#{bin}/shell --version")
    assert_match "shell.online", shell_output("#{bin}/shell help")
  end
end
