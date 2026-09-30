class ShellOnline < Formula
  desc "Turn any terminal process into an interactive or read-only browser link"
  homepage "https://shell.online"
  url "https://github.com/TeoSlayer/shell.online/archive/refs/tags/v0.24.1.tar.gz"
  sha256 "de48037583a54511e35b1e6c4709f98bf027afec455c6b8cc6b13eefa0cd179c"
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
