package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
)

type SessionContentPolicy struct {
	Enabled       bool   `json:"enabled"`
	Generation    string `json:"generation"`
	OwnerUID      string `json:"ownerUid"`
	NextPublishAt int64  `json:"nextPublishAt"`
}
type SessionContentUpload struct {
	Generation      string `json:"generation"`
	ObservedAt      int64  `json:"observedAt"`
	SenderPublicKey string `json:"senderPublicKey"`
	Sealed          string `json:"sealed"`
}

func (client *Client) SessionContentPolicy(ctx context.Context, bearer, id string) (SessionContentPolicy, error) {
	var policy SessionContentPolicy
	data, err := client.do(ctx, http.MethodGet, "/api/cli/sessions/"+url.PathEscape(id)+"/content-policy", bearer, nil)
	if err != nil {
		return policy, err
	}
	err = json.Unmarshal(data, &policy)
	return policy, err
}
func (client *Client) PublishSessionContent(ctx context.Context, bearer, id string, content SessionContentUpload) error {
	_, err := client.do(ctx, http.MethodPut, "/api/cli/sessions/"+url.PathEscape(id)+"/content", bearer, content)
	return err
}
