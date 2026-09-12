class ShellOnline < Formula
  desc "Turn any terminal process into an interactive or read-only browser link"
  homepage "https://shell.online"
  url "https://github.com/TeoSlayer/shell.online/archive/refs/tags/v0.12.2.tar.gz"
  sha256 "81ed2fe7dfa4ec6bf56e77de46428cb6d449b7c7dd300f29c911ab4e0dde983e"
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
