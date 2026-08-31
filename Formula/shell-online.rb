class ShellOnline < Formula
  desc "Turn any terminal process into an interactive or read-only browser link"
  homepage "https://shell.online"
  url "https://github.com/TeoSlayer/shell.online/archive/refs/tags/v0.6.0.tar.gz"
  sha256 "f4c4ee3dea8ff633847ff39b86e61d816b6d0b5069af24126e671a2e19b2afa1"
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
